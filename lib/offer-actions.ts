"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { currentUser } from "@/lib/current-user"
import { db } from "@/lib/db"
import { MIN_CELL } from "@/lib/disclosure"
import { hasEntitlement } from "@/lib/entitlements"
import { logger } from "@/lib/logger"
import { findContactInfo } from "@/lib/moderation/contact-info"
import { checkKeywords } from "@/lib/moderation/keyword-filter"
import { deliverOffer } from "@/lib/offers/deliver"
import { codeMatches, normaliseCode } from "@/lib/offers/pass-code"
import { nextOfferAt, OFFERS_PER_WEEK, sentThisWeek } from "@/lib/offers/venue"
import { activeMembership } from "@/lib/org-membership"
import { violatedConstraint } from "@/lib/prisma-errors"
import { overUserLimit } from "@/lib/rate-limit"
import { mayRedeemAtVenue, maySendVenueOffers } from "@/lib/rbac"
import { Refusal } from "@/lib/refusal"
import { audienceSql, REGULAR_NIGHTS, REGULAR_WINDOW_DAYS } from "@/lib/regulars"
import { venueDayBounds } from "@/lib/venue-day"

/**
 * A venue's two actions on regulars (step 12, plan v2 §2): send an offer, and
 * redeem a pass at the door.
 *
 * ## Sending: blind, floored, quota'd, Pro
 *
 * The venue writes the words and we choose who: its regulars
 * (`lib/regulars.ts`). The audience is found and written in ONE statement —
 * `INSERT … SELECT` — so the code never holds its ids, and an audience under
 * 5 writes nothing and returns nothing: the venue is told "fewer than 5", never
 * how many fewer, and no row, push or quota is spent. Two a week per venue,
 * counted under a lock so two tabs cannot both send the second. Venue Pro,
 * asked here on the server. The words go through the keyword filter and the
 * room's contact-details rule.
 *
 * ## Redeeming: single use, under a race
 *
 * Staff type the code on the person's pass and tap "Redeemed". The code is
 * matched only against passes on screen at this venue in the last minutes
 * (`pass_seen_at`), then redeemed by `updateMany … WHERE redeemed_at IS
 * NULL`: two taps at once redeem once, and the second is told so. One pass a
 * night per person per venue is a unique index. Staff learn the offer's words
 * — the person is standing in front of them — and nothing else.
 */

const NOT_YOUR_VENUE = "This venue isn't yours to send offers from."
const NOT_A_PASS_HERE = "That code isn't a live pass here. Ask them to open the pass again."
const UNDER_FLOOR = `Fewer than ${MIN_CELL} regulars right now, so nothing was sent. A regular has come on ${REGULAR_NIGHTS} or more nights in the last ${REGULAR_WINDOW_DAYS}.`
const MAX_DAYS = 14
/** A pass shown in the last three minutes is one being shown at the door. */
const ON_SCREEN_MS = 3 * 60 * 1000

const sendInput = z.object({
  venueId: z.uuid(),
  text: z.string().trim().min(1, "Write the offer.").max(140, "An offer is at most 140 characters."),
  days: z.number().int().min(1).max(MAX_DAYS),
})

const redeemInput = z.object({ venueId: z.uuid(), code: z.string().max(20) })

/** Why these words cannot go out, or null. */
function offerTextRefusal(text: string): string | null {
  if (checkKeywords(text)?.action === "hide") return "This can't be sent as an offer."
  const contact = findContactInfo(text)
  if (contact.length > 0) {
    return `${[...new Set(contact.map((c) => c.hint))].join(" ")} An offer can't carry contact details: people find you in the app.`
  }
  return null
}

const DAY = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })

export async function sendOffer(input: { venueId: string; text: string; days: number }): Promise<{ offerId: string; sent: number }> {
  const user = await currentUser()
  if (!user) throw new Refusal("Unauthorized")
  const parsed = sendInput.safeParse(input)
  if (!parsed.success) throw new Refusal(parsed.error.issues[0]?.message ?? "That offer can't be sent.")
  const { venueId, text, days } = parsed.data
  if (await overUserLimit("heavy", "offer-send", user.id)) throw new Refusal("Too many tries. Wait a minute and send again.")

  const venue = await db.venues.findFirst({
    where: { id: venueId, deleted_at: null },
    select: { id: true, timezone: true, day_reset_hour: true, claimed_at: true, owner_org_id: true },
  })
  if (!venue?.owner_org_id || !venue.claimed_at) throw new Refusal(NOT_YOUR_VENUE)
  const member = await db.organisation_members.findFirst({
    where: { user_id: user.id, org_id: venue.owner_org_id, ...activeMembership },
    select: { role: true },
  })
  if (!member) throw new Refusal(NOT_YOUR_VENUE)
  if (!maySendVenueOffers(user.role, member.role)) throw new Refusal("Only an owner or admin of the venue's organisation can send offers.")
  if (!(await hasEntitlement({ kind: "venue", id: venueId }, "venue_pro"))) {
    throw new Refusal("Offers to regulars are part of Venue Pro. See your plan to add it.")
  }
  const refusal = offerTextRefusal(text)
  if (refusal) throw new Refusal(refusal)

  const now = new Date()
  const v = { ...venue, claimed_at: venue.claimed_at, owner_org_id: venue.owner_org_id }
  const endsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  const { offerId, sent } = await db.$transaction(async (tx) => {
    // One send at a time per venue, so the week's count is the count.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`offers:${venueId}`}, 0))`
    const week = await sentThisWeek(venueId, now, tx)
    const next = nextOfferAt(week)
    if (next) throw new Refusal(`This venue has sent its ${OFFERS_PER_WEEK} offers this week. The next can go ${DAY.format(next)}.`)

    // The audience, its size and the sends in one statement: under 5, the
    // offer is not inserted, so neither are the sends, and nothing comes back.
    const rows = await tx.$queryRaw<{ id: string; audience_size: number }[]>`
      WITH audience AS MATERIALIZED (${audienceSql(v, now)}),
           size AS (SELECT count(*)::int AS n FROM audience),
           offer AS (
             INSERT INTO venue_offers (venue_id, org_id, created_by, text, audience, audience_size, ends_at, created_at)
             SELECT ${venueId}::uuid, ${venue.owner_org_id}::uuid, ${user.id}, ${text}, 'regulars', size.n, ${endsAt}, ${now}
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
    await tx.audit_logs.create({
      data: {
        user_id: user.id,
        action: "venue_offer.send",
        resource: "venue",
        resource_id: venueId,
        details: { offerId: offer.id, audience: offer.audience_size, days: days },
      },
    })
    return { offerId: offer.id, sent: offer.audience_size }
  })

  void deliverOffer(offerId)
  revalidatePath(`/dashboard/venues/${venueId}`)
  return { offerId, sent }
}

export async function redeemPass(input: { venueId: string; code: string }): Promise<{ text: string }> {
  const user = await currentUser()
  if (!user) throw new Refusal("Unauthorized")
  const parsed = redeemInput.safeParse(input)
  if (!parsed.success) throw new Refusal(NOT_A_PASS_HERE)
  if (await overUserLimit("write", "offer-redeem", user.id)) throw new Refusal("Too many tries. Wait a minute and try again.")
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
  if (!venue?.owner_org_id || !member) throw new Refusal(NOT_A_PASS_HERE)

  const now = new Date()
  const onScreen = await db.venue_offer_sends.findMany({
    where: { venue_id: venueId, pass_seen_at: { gte: new Date(now.getTime() - ON_SCREEN_MS) }, offer: { org_id: venue.owner_org_id } },
    select: { id: true, redeemed_at: true, offer: { select: { id: true, text: true, ends_at: true } } },
  })
  const pass = onScreen.find((s) => codeMatches(s.id, code, now))
  if (!pass) throw new Refusal(NOT_A_PASS_HERE)
  if (pass.redeemed_at) throw new Refusal("This pass was already redeemed.")
  if (pass.offer.ends_at <= now) throw new Refusal("This offer has ended.")

  const tonight = new Date(`${venueDayBounds(venue.timezone, venue.day_reset_hour, now).localDate}T00:00:00Z`)
  try {
    await db.$transaction(async (tx) => {
      const { count } = await tx.venue_offer_sends.updateMany({
        where: { id: pass.id, redeemed_at: null },
        data: { redeemed_at: now, redeemed_night: tonight },
      })
      if (count === 0) throw new Refusal("This pass was already redeemed.")
      await tx.audit_logs.create({
        data: { user_id: user.id, action: "venue_offer.redeem", resource: "venue", resource_id: venueId, details: { offerId: pass.offer.id } },
      })
    })
  } catch (error) {
    if (violatedConstraint(error, "venue_offer_sends_one_pass_a_night")) {
      throw new Refusal("They've already used a pass here tonight. One a night.")
    }
    if (!(error instanceof Refusal)) logger.error("Pass redemption failed", { venueId, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
  revalidatePath(`/dashboard/venues/${venueId}`)
  return { text: pass.offer.text }
}
