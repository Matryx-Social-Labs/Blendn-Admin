"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { auditInTx, auditLog } from "@/lib/audit-log"
import { currentUser, requireAdmin } from "@/lib/current-user"
import { db } from "@/lib/db"
import { MIN_CELL } from "@/lib/disclosure"
import { hasEntitlement } from "@/lib/entitlements"
import { logger } from "@/lib/logger"
import { findProfileContactInfo } from "@/lib/moderation/contact-info"
import { checkKeywords } from "@/lib/moderation/keyword-filter"
import { checkTextContent } from "@/lib/moderation/openai-moderation"
import { checkSpam } from "@/lib/moderation/spam-detector"
import { deliverOffer } from "@/lib/offers/deliver"
import { regularsActive } from "@/lib/offers/person"
import { codeMatches, normaliseCode } from "@/lib/offers/pass-code"
import { audienceBand, nextOfferAt, OFFERS_PER_WEEK, sentThisWeek, type AudienceBand } from "@/lib/offers/venue"
import { activeMembership } from "@/lib/org-membership"
import { violatedConstraint } from "@/lib/prisma-errors"
import { hit, peek, StoreUnavailable } from "@/lib/rate-limit-store"
import { mayRedeemAtVenue, maySendVenueOffers } from "@/lib/rbac"
import { Refusal } from "@/lib/refusal"
import { audienceSql, REGULAR_NIGHTS, REGULAR_WINDOW_DAYS } from "@/lib/regulars"
import { venueDayBounds } from "@/lib/venue-day"

/**
 * A venue's two actions on regulars (step 12, plan v2 §2) — send an offer, and
 * redeem a pass at the door — and an admin's third: end one.
 *
 * ## Sending: blind, floored, quota'd, moderated, Pro
 *
 * The venue writes the words and we choose who: its regulars
 * (`lib/regulars.ts`). The audience is found and written in ONE statement —
 * `INSERT … SELECT` — so the code never holds its ids, and an audience under
 * 5 writes nothing and returns nothing: the venue is told one fixed sentence,
 * whatever the size. What it is told of a send is a band (`audienceBand`),
 * never the number. Two a week per venue, counted under a lock, and the venue,
 * its owner, the sender's membership and Venue Pro are read again under that
 * lock (review L4): a plan ending or a transfer between the check and the send
 * cannot slip one through.
 *
 * The words go through the room's pipeline (review M5): the keyword filter,
 * contact details in the strict reading a card gets — phone numbers, handles,
 * emails, any web address or bare domain — repeats, and OpenAI's moderation
 * when it is configured. A refusal says why, and is recorded for admins as a
 * `venue_offer.refused` audit row with the category. Not `moderation_flags`:
 * that table is a chat message's (a NOT NULL key to `chat_messages`, read by
 * twenty-two places that assume one), and a refused offer reached nobody.
 *
 * ## Redeeming: single use, under a race, and not guessable
 *
 * Staff type the code on the person's pass and tap "Redeemed". The code is
 * matched only against passes on screen at this venue in the last minutes;
 * two passes matching the same code is refused rather than guessed (L3),
 * without saying whose. It is redeemed by `updateMany … WHERE redeemed_at IS
 * NULL`: two taps at once redeem once. One pass a night per person per venue
 * is a unique index. Staff learn the offer's words — the person is standing
 * in front of them — and nothing else.
 *
 * ## The door's lock, and the limits (review L1, the race and DoS scans)
 *
 * Only the venue's own people reach the counting: an active owner, admin or
 * staff member of the organisation that owns it, on the role the database
 * holds. Anyone else is refused first and never touches a counter.
 *
 * Wrong codes are counted **per staff account at this venue**: atomically
 * (Redis INCR; this process's map only where there is no Redis at all), and
 * answered AFTER counting, so the tenth inside five minutes
 * and every one after it say "locked", however many arrive at once. The lock
 * is that account's alone: one staff member cannot shut the door on every
 * regular, and a colleague's valid pass still works. A right code from a
 * locked account is refused — on arrival and again just before the write, so
 * a lock that lands mid-flight still stops it. Nothing clears a count (a
 * valid pass is no reset button); counts expire with their windows.
 *
 * A venue-wide count is the backstop against brute force spread over many
 * accounts: past 100 wrong codes in ten minutes every attempt at the venue is
 * slowed, more the further past it goes, and the crossing is logged and
 * audited for admins. Slowed, never blocked: the regulars at the door are not
 * the attacker.
 *
 * Every offers counter is fail-closed (`{ failClosed: true }`,
 * lib/rate-limit-store.ts): with Redis configured and unable to answer, the
 * door and sends refuse rather than count in one replica's memory, where the
 * count would drift and a restart would hand out a fresh budget. Each limit
 * sits after authorisation and before any side effect, keyed on what the
 * server derived: the organisation and venue for a send, the venue and staff
 * member at the door.
 */

const NOT_YOUR_VENUE = "This venue isn’t yours to send offers from."
const NOT_A_PASS_HERE = "That code isn’t a live pass here. Ask them to open the pass again."
const UNDER_FLOOR = `Fewer than ${MIN_CELL} regulars right now, so nothing was sent. A regular has come on ${REGULAR_NIGHTS} or more nights in the last ${REGULAR_WINDOW_DAYS}.`
const MAX_DAYS = 14
/** A pass shown in the last three minutes is one being shown at the door. */
const ON_SCREEN_MS = 3 * 60 * 1000
/** Wrong codes at one venue's door before it locks, and for how long (L1). */
const DOOR_FAILURES = 10
const DOOR_LOCK_MS = 5 * 60 * 1000
/** How long OpenAI may hold a send. The deterministic checks have run by then. */
const OPENAI_BOUND_MS = 3000
const DOOR_LOCKED = "Too many wrong codes from this account. Wait five minutes, then try again."
/** The venue-wide backstop: wrong codes in its window before attempts slow down, and by how much. */
const VENUE_BACKSTOP = 100
const VENUE_BACKSTOP_WINDOW_MS = 10 * 60 * 1000
const BACKSTOP_DELAY_STEP_MS = 200
const BACKSTOP_DELAY_MAX_MS = 5000
const STORE_DOWN = "This can’t be checked right now. Try again in a minute."
/** Sends a minute per organisation and venue, and door attempts a minute per venue and staff member. */
const SENDS_PER_MINUTE = 5
const DOOR_TRIES_PER_MINUTE = 30
const MINUTE_MS = 60 * 1000

const CLOSED = { failClosed: true } as const

/** A fail-closed counter's answer, or the refusal when its store cannot give one. */
async function counted<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof StoreUnavailable) {
      logger.error("Offer limit store unavailable: refusing", { error: error.message })
      throw new Refusal(STORE_DOWN)
    }
    throw error
  }
}

/** Over a limit, counted fail-closed. */
const overLimit = async (key: string, max: number, windowMs: number): Promise<boolean> =>
  (await counted(() => hit(key, windowMs, CLOSED))).count > max

const staffKey = (venueId: string, userId: string) => `door-fail:${venueId}:${userId}`
const venueKey = (venueId: string) => `door-fail-venue:${venueId}`

/** Past the venue-wide backstop, every attempt waits — longer the further past (review DoS scan). */
async function backstopDelay(venueId: string): Promise<void> {
  const over = (await counted(() => peek(venueKey(venueId), CLOSED))) - VENUE_BACKSTOP
  if (over > 0) await new Promise((r) => setTimeout(r, Math.min(over * BACKSTOP_DELAY_STEP_MS, BACKSTOP_DELAY_MAX_MS)))
}

const sendInput = z.object({
  venueId: z.uuid(),
  text: z.string().trim().min(1, "Write the offer.").max(140, "An offer is at most 140 characters."),
  days: z.number().int().min(1).max(MAX_DAYS),
})

const redeemInput = z.object({ venueId: z.uuid(), code: z.string().max(20) })
const endInput = z.object({ offerId: z.uuid(), reason: z.string().trim().min(10, "Say why, in a sentence.").max(500) })

/** Why these words cannot go out, and the category recorded for admins; or null. */
async function offerTextRefusal(venueId: string, text: string): Promise<{ message: string; category: string } | null> {
  if (checkKeywords(text)?.action === "hide") return { message: "This can’t be sent as an offer.", category: "keyword" }
  const contact = findProfileContactInfo(text)
  if (contact.length > 0) {
    return {
      message: `${[...new Set(contact.map((c) => c.hint))].join(" ")} An offer can’t carry contact details or links: people find you in the app.`,
      category: `contact:${[...new Set(contact.map((c) => c.kind))].join(",")}`,
    }
  }
  if (await checkSpam(`venue:${venueId}`, "venue-offers", text)) {
    return { message: "This reads like a repeat. Change the offer before sending it again.", category: "spam" }
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const check = await Promise.race([
    checkTextContent(text),
    new Promise<{ checked: false; reason: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ checked: false, reason: "timeout" }), OPENAI_BOUND_MS)
    }),
  ]).finally(() => clearTimeout(timeout))
  // ponytail: an OpenAI timeout or outage passes, as the room's does; the deterministic checks have run.
  if (check.checked && check.result) return { message: "This can’t be sent as an offer.", category: "openai" }
  return null
}

/** The venue and the sender's place in it, as they are now: the gate, run before the lock and again under it. */
async function senderAt(client: Pick<typeof db, "venues" | "organisation_members">, venueId: string, userId: string) {
  const venue = await client.venues.findFirst({
    where: { id: venueId, deleted_at: null },
    select: { id: true, name: true, timezone: true, day_reset_hour: true, claimed_at: true, owner_org_id: true },
  })
  if (!venue?.owner_org_id || !venue.claimed_at) return null
  const member = await client.organisation_members.findFirst({
    where: { user_id: userId, org_id: venue.owner_org_id, ...activeMembership },
    select: { role: true },
  })
  return member ? { place: { ...venue, owner_org_id: venue.owner_org_id, claimed_at: venue.claimed_at }, member } : null
}

export async function sendOffer(input: { venueId: string; text: string; days: number }): Promise<{ offerId: string; reached: AudienceBand }> {
  const user = await currentUser()
  if (!user) throw new Refusal("Unauthorized")
  const parsed = sendInput.safeParse(input)
  if (!parsed.success) throw new Refusal(parsed.error.issues[0]?.message ?? "That offer can’t be sent.")
  const { venueId, text, days } = parsed.data

  const gate = await senderAt(db, venueId, user.id)
  if (!gate) throw new Refusal(NOT_YOUR_VENUE)
  if (!maySendVenueOffers(user.role, gate.member.role)) throw new Refusal("Only an owner or admin of the venue’s organisation can send offers.")
  // Per organisation and venue: colleagues share it, and another venue of theirs has its own.
  // After the role check: staff who may not send must not be able to spend the owner's minute.
  if (await overLimit(`offer-send:${gate.place.owner_org_id}:${venueId}`, SENDS_PER_MINUTE, MINUTE_MS)) {
    throw new Refusal("Too many tries. Wait a minute and send again.")
  }
  if (!(await hasEntitlement({ kind: "venue", id: venueId }, "venue_pro"))) {
    throw new Refusal("Offers to regulars are part of Venue Pro. See your plan to add it.")
  }
  /*
   * No offer reaches anybody until regulars is switched on (review M2): only then does the app show "Offers from
   * places", the switch that turns them off, so nobody gets a promotion with no way to stop it. Existing profiles
   * still hold the `true` they were given before S-5; whether to reset them is the owner's call when regulars launch.
   */
  if (!(await regularsActive({ venueId }))) {
    throw new Refusal("Offers to regulars aren’t switched on yet, so nothing was sent.", "REGULARS_INACTIVE")
  }
  const refusal = await offerTextRefusal(venueId, text)
  if (refusal) {
    auditLog({ userId: user.id, action: "venue_offer.refused", resource: "venue", resourceId: venueId, details: { category: refusal.category, text } })
    throw new Refusal(refusal.message)
  }

  const now = new Date()
  const endsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  const { offerId, size } = await db.$transaction(async (tx) => {
    // One send at a time per venue, so the week's count is the count.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`offers:${venueId}`}, 0))`
    // Again under the lock (L4): the owner, the sender's role and the plan as they are now.
    const held = await senderAt(tx, venueId, user.id)
    if (!held || held.place.owner_org_id !== gate.place.owner_org_id) throw new Refusal(NOT_YOUR_VENUE)
    if (!maySendVenueOffers(user.role, held.member.role)) throw new Refusal("Only an owner or admin of the venue’s organisation can send offers.")
    if (!(await hasEntitlement({ kind: "venue", id: venueId }, "venue_pro", {}, now, tx))) {
      throw new Refusal("Offers to regulars are part of Venue Pro. See your plan to add it.")
    }
    const week = await sentThisWeek(venueId, now, tx)
    const next = nextOfferAt(week)
    if (next) throw new Refusal(`This venue has sent its ${OFFERS_PER_WEEK} offers this week. The next can go ${DAY.format(next)}.`)

    // The audience, its size and the sends in one statement: under 5, the
    // offer is not inserted, so neither are the sends, and nothing comes back.
    const rows = await tx.$queryRaw<{ id: string; audience_size: number }[]>`
      WITH audience AS MATERIALIZED (${audienceSql(held.place, now)}),
           size AS (SELECT count(*)::int AS n FROM audience),
           offer AS (
             INSERT INTO venue_offers (venue_id, org_id, created_by, text, audience, audience_size, ends_at, created_at)
             SELECT ${venueId}::uuid, ${held.place.owner_org_id}::uuid, ${user.id}, ${text}, 'regulars', size.n, ${endsAt}, ${now}
               FROM size WHERE size.n >= ${MIN_CELL}
             RETURNING id, audience_size
           ),
           sends AS (
             INSERT INTO venue_offer_sends (offer_id, venue_id, user_id, sent_at)
             SELECT offer.id, ${venueId}::uuid, audience.user_id, ${now} FROM offer, audience
           )
      -- A data-modifying CTE runs whether or not it is read: the sends are written when this returns.
      SELECT offer.id::text AS id, offer.audience_size FROM offer`
    const offer = rows[0]
    if (!offer) throw new Refusal(UNDER_FLOOR)
    // The band, never the number: this row is in the venue's own audit log.
    await auditInTx(tx, {
      userId: user.id,
      action: "venue_offer.send",
      resource: "venue",
      resourceId: venueId,
      details: { offerId: offer.id, reached: audienceBand(offer.audience_size), days: days },
    })
    return { offerId: offer.id, size: offer.audience_size }
  })

  void deliverOffer(offerId)
  revalidatePath(`/dashboard/venues/${venueId}`)
  return { offerId, reached: audienceBand(size) ?? "5–9" }
}

const DAY = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })

export async function redeemPass(input: { venueId: string; code: string }): Promise<{ text: string }> {
  const user = await currentUser()
  if (!user) throw new Refusal("Unauthorized")
  const parsed = redeemInput.safeParse(input)
  if (!parsed.success) throw new Refusal(NOT_A_PASS_HERE)
  const code = normaliseCode(parsed.data.code)
  if (!code) throw new Refusal("A pass code is six letters and numbers.")
  const { venueId } = parsed.data

  // Staff of this venue's organisation, or the same answer as a wrong code:
  // another venue's staff learn nothing about this venue's passes.
  const venue = await db.venues.findFirst({
    where: { id: venueId, deleted_at: null },
    select: { id: true, owner_org_id: true, timezone: true, day_reset_hour: true },
  })
  const member =
    venue?.owner_org_id && mayRedeemAtVenue(user.role)
      ? await db.organisation_members.findFirst({
          where: { user_id: user.id, org_id: venue.owner_org_id, ...activeMembership },
          select: { id: true },
        })
      : null
  // Authorised before anything is counted: nobody outside the venue's organisation touches its counters.
  if (!venue?.owner_org_id || !member) throw new Refusal(NOT_A_PASS_HERE)
  if (await overLimit(`offer-redeem:${venueId}:${user.id}`, DOOR_TRIES_PER_MINUTE, MINUTE_MS)) {
    throw new Refusal("Too many tries. Wait a minute and try again.")
  }
  if ((await counted(() => peek(staffKey(venueId, user.id), CLOSED))) >= DOOR_FAILURES) throw new Refusal(DOOR_LOCKED)
  await backstopDelay(venueId)

  // A wrong code counts first and is answered after: the one that reaches this
  // account's limit, and every one after it, however many are in flight, says locked.
  const wrong = async (message: string): Promise<never> => {
    const mine = (await counted(() => hit(staffKey(venueId, user.id), DOOR_LOCK_MS, CLOSED))).count
    const all = (await counted(() => hit(venueKey(venueId), VENUE_BACKSTOP_WINDOW_MS, CLOSED))).count
    if (all === VENUE_BACKSTOP) {
      logger.error("Offer door backstop crossed: wrong codes across staff accounts", { venueId, failures: all })
      // The platform's, not the venue's: org null.
      auditLog({ userId: user.id, action: "venue_offer.door_backstop", resource: "venue", resourceId: venueId, orgId: null, details: { failures: all } })
    }
    throw new Refusal(mine >= DOOR_FAILURES ? DOOR_LOCKED : message)
  }

  const now = new Date()
  const onScreen = await db.venue_offer_sends.findMany({
    where: { venue_id: venueId, pass_seen_at: { gte: new Date(now.getTime() - ON_SCREEN_MS) }, offer: { org_id: venue.owner_org_id } },
    select: { id: true, redeemed_at: true, offer: { select: { id: true, text: true, ends_at: true } } },
  })
  const matching = onScreen.filter((s) => codeMatches(s.id, code, now))
  if (matching.length === 0) return wrong(NOT_A_PASS_HERE)
  // Two passes on screen with one code: refuse rather than guess whose (L3).
  if (matching.length > 1) throw new Refusal("Two passes show that code right now. Wait for it to change, then type the new one.")
  const pass = matching[0]
  if (pass.redeemed_at) throw new Refusal("This pass was already redeemed.")
  if (pass.offer.ends_at <= now) throw new Refusal("This offer has ended.")

  // Again just before the write: this account's wrong codes in flight may have locked it since this one arrived.
  if ((await counted(() => peek(staffKey(venueId, user.id), CLOSED))) >= DOOR_FAILURES) throw new Refusal(DOOR_LOCKED)
  const tonight = new Date(`${venueDayBounds(venue.timezone, venue.day_reset_hour, now).localDate}T00:00:00Z`)
  try {
    await db.$transaction(async (tx) => {
      const { count } = await tx.venue_offer_sends.updateMany({
        where: { id: pass.id, redeemed_at: null },
        data: { redeemed_at: now, redeemed_night: tonight },
      })
      if (count === 0) throw new Refusal("This pass was already redeemed.")
      await auditInTx(tx, { userId: user.id, action: "venue_offer.redeem", resource: "venue", resourceId: venueId, details: { offerId: pass.offer.id } })
    })
  } catch (error) {
    if (violatedConstraint(error, "venue_offer_sends_one_pass_a_night")) {
      throw new Refusal("They’ve already used a pass here tonight. One a night.")
    }
    if (!(error instanceof Refusal)) logger.error("Pass redemption failed", { venueId, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
  revalidatePath(`/dashboard/venues/${venueId}`)
  return { text: pass.offer.text }
}

/**
 * End an offer now (review M5): an admin's lever for an offer reported from
 * the app or seen in the queue. Its passes stop at once; audited with why.
 */
export async function endOffer(input: { offerId: string; reason: string }): Promise<{ endedAt: string }> {
  const admin = await requireAdmin()
  const parsed = endInput.safeParse(input)
  if (!parsed.success) throw new Refusal(parsed.error.issues[0]?.message ?? "That offer can’t be ended.")
  const now = new Date()
  const venueId = await db.$transaction(async (tx) => {
    const offer = await tx.venue_offers.findUnique({ where: { id: parsed.data.offerId }, select: { venue_id: true, ends_at: true } })
    if (!offer) throw new Refusal("No such offer.")
    const { count } = await tx.venue_offers.updateMany({ where: { id: parsed.data.offerId, ends_at: { gt: now } }, data: { ends_at: now } })
    if (count === 0) throw new Refusal("This offer has already ended.")
    await auditInTx(tx, {
      userId: admin.id,
      action: "venue_offer.end",
      resource: "venue",
      resourceId: offer.venue_id,
      details: { offerId: parsed.data.offerId, reason: parsed.data.reason },
    })
    return offer.venue_id
  })
  revalidatePath(`/dashboard/venues/${venueId}`)
  return { endedAt: now.toISOString() }
}
