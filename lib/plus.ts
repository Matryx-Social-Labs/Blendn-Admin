import "server-only"

import { Prisma } from "@prisma/client"

import { attendedEventIds } from "./attendee-counts"
import { ATTENDED } from "./counting"
import { db } from "./db"
import { addMonths, grantPlusOnce, hasEntitlement, plusGrantsSince } from "./entitlements"
import { plusGateFor, plusGatedAnywhere } from "./env"

/**
 * Blendn+ for attendees (plan v2 §9.3), configured here and nowhere else.
 *
 * What Plus is: staying live while you're here, your full night history (free
 * keeps the last 3), partner perks, crew extras. Every one of them asks
 * `plusRequired` on the server. Perks and crew extras do not exist yet; they
 * call it when they land (SCRUM-584). "History" is `/me/attendance` only: a
 * room's own messages follow the room's rules, not Plus (review L7).
 *
 * What is NEVER sold (owner ruling 2026-10-01): who liked you, more than the
 * caps allow, seeing a venue without going live, a reveal bypass, boosting.
 * `__tests__/plus-gate-boundary.test.ts` holds the list of files allowed to
 * ask, so none of those can quietly start asking.
 *
 * Where it is sold: `PLUS_GATING` (lib/env.ts) names the gated cities and the
 * day each flipped. A city not named is in its launch season, everything
 * unlocked.
 *
 * What we give away, once each per account, at the moment it matters — the
 * first time the account would be refused in a gated city:
 *   - **the trial**: 14 days, to an account that already existed when that
 *     city flipped and had come out in the 90 days before it. What it is for
 *     is softening the flip for people already here; an account made after
 *     the flip gets none, so a fresh account is not a fresh trial.
 *   - **a referral month**: three people who signed up through your invite
 *     link (new accounts, onboarded and 18+) each checked in at a DIFFERENT
 *     event, each with at least 5 other people there (not you, not others you
 *     invited), at least 72 hours ago — and are still here (not deleted, not
 *     suspended) when it is paid. Each invitee counts toward one month, ever;
 *     at most 3 months a year. A request sent or accepted earns nothing.
 * Both are decided under a per-person lock with Plus read again inside it, so
 * concurrent requests grant one thing at most, and each is audited in the
 * transaction that grants it (a refused audit takes the grant back).
 */
export const PLUS = {
  /** Nights of history everyone keeps; older ones are Plus. */
  FREE_HISTORY_NIGHTS: 3,
  /** A Night Pass: Plus for this long from purchase, or from the end of the last one not yet over (D-16). */
  NIGHT_PASS_MS: 24 * 60 * 60 * 1000,
  TRIAL_DAYS: 14,
  /** "Active" before the flip: came out at least once in this many days before it. */
  TRIAL_ACTIVE_DAYS: 90,
  REFERRAL_FRIENDS: 3,
  REFERRAL_MONTHS: 1,
  /** A referral month is paid only once its third qualifying night is this old. */
  REFERRAL_DELAY_HOURS: 72,
  /** Each qualifying night was an event with at least this many other people there. */
  REFERRAL_MIN_OTHERS: 5,
  /** At most this many referral months in a year. */
  REFERRAL_MONTHS_PER_YEAR: 3,
  /**
   * A referral is a new signup: the invitee's account is at most this many
   * days old when they first use the link. Somebody already on Blendn tapping
   * a friend's link is a friend request, not a referral.
   */
  REFERRAL_NEW_ACCOUNT_DAYS: 7,
  /**
   * How the stores' purchases are told apart (docs/IAP-SETUP.md). Plus is
   * RevenueCat's entitlement `plus`, attached to the three subscriptions. The
   * Night Pass is NOT attached to it — RevenueCat would hold a non-renewing
   * product for life — so it is known by its product id and lasts
   * `NIGHT_PASS_MS` here.
   */
  STORE: {
    ENTITLEMENT: "plus",
    NIGHT_PASS_PRODUCTS: ["blendn_night_pass"],
  },
} as const

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
type Client = Prisma.TransactionClient | typeof db
const user = (id: string) => ({ kind: "user" as const, id })

/** The trial's reference: one per account, ever. */
export const trialRef = (userId: string) => `plus-trial:${userId}`
/** A referral month's reference names the three invitees it was for. */
export const REFERRAL_REF_PREFIX = "plus-referral:"
const referralRef = (inviterId: string, invitees: string[]) => `${REFERRAL_REF_PREFIX}${inviterId}:${[...invitees].sort().join("+")}`

/**
 * Does this person hold Blendn+ now: the subscription (or one of our grants),
 * or a live Night Pass — 24 hours of Plus. The rule that a pass counts as Plus
 * lives here and only here; `hasEntitlement` answers for exactly the product it
 * is asked about.
 */
export async function hasPlus(userId: string, now: Date = new Date(), client: Client = db): Promise<boolean> {
  // One after the other: inside a transaction there is one connection.
  return (
    (await hasEntitlement(user(userId), "plus", {}, now, client)) ||
    (await hasEntitlement(user(userId), "night_pass", {}, now, client))
  )
}

/** Was this account here, and out, before its city flipped? Then the trial is theirs to have once. */
async function trialEligible(tx: Prisma.TransactionClient, userId: string, flippedAt: Date): Promise<boolean> {
  const since = new Date(flippedAt.getTime() - PLUS.TRIAL_ACTIVE_DAYS * DAY_MS)
  const [row] = await tx.$queryRaw<{ yes: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "User" u
       WHERE u.id = ${userId} AND u."createdAt" < ${flippedAt}
         AND EXISTS (
           SELECT 1 FROM event_check_ins ci
            WHERE ci.user_id = u.id
              AND ci.kind = 'attendee'
              AND ci.status::text IN (${Prisma.join(ATTENDED)})
              AND ci.check_in_time >= ${since} AND ci.check_in_time < ${flippedAt}
         )
    ) AS yes`
  return row?.yes === true
}

/**
 * Three of this inviter's unrewarded invitees who each qualify on a different
 * event, or null. A qualifying night: an attended check-in after the referral,
 * at least `REFERRAL_DELAY_HOURS` old, at an event with at least
 * `REFERRAL_MIN_OTHERS` other attendees who are neither the inviter nor anyone
 * else they invited. The invitee must still be here — not deleted, not
 * suspended — when it is paid.
 */
async function referralTriple(tx: Prisma.TransactionClient, inviterId: string, now: Date): Promise<string[] | null> {
  const ripe = new Date(now.getTime() - PLUS.REFERRAL_DELAY_HOURS * HOUR_MS)
  const pairs = await tx.$queryRaw<{ invitee_id: string; event_id: string }[]>`
    SELECT DISTINCT r.invitee_id, ci.event_id::text AS event_id
      FROM referrals r
      JOIN "User" u ON u.id = r.invitee_id AND u."deletedAt" IS NULL AND u.suspended_at IS NULL
      JOIN event_check_ins ci ON ci.user_id = r.invitee_id
     WHERE r.inviter_id = ${inviterId}
       AND r.rewarded_at IS NULL
       AND ci.kind = 'attendee'
       AND ci.status::text IN (${Prisma.join(ATTENDED)})
       AND ci.check_in_time >= r.created_at
       AND ci.check_in_time <= ${ripe}
       AND (
         SELECT count(DISTINCT o.user_id) FROM event_check_ins o
          WHERE o.event_id = ci.event_id
            AND o.kind = 'attendee'
            AND o.status::text IN (${Prisma.join(ATTENDED)})
            AND o.user_id <> ${inviterId}
            AND o.user_id NOT IN (SELECT invitee_id FROM referrals WHERE inviter_id = ${inviterId})
       ) >= ${PLUS.REFERRAL_MIN_OTHERS}
     LIMIT 500`
  const eventsOf = new Map<string, Set<string>>()
  for (const p of pairs) eventsOf.set(p.invitee_id, (eventsOf.get(p.invitee_id) ?? new Set()).add(p.event_id))
  return threeOnDistinctEvents(eventsOf)
}

/**
 * Three people who can each be given a different event (Hall's condition for
 * three sets: each has one, any two have two between them, all three have
 * three). Exported for its unit test.
 */
export function threeOnDistinctEvents(eventsOf: Map<string, Set<string>>): string[] | null {
  const people = [...eventsOf.keys()].slice(0, 30)
  const union = (...ids: string[]) => new Set(ids.flatMap((id) => [...eventsOf.get(id)!])).size
  for (let i = 0; i < people.length; i++)
    for (let j = i + 1; j < people.length; j++)
      for (let k = j + 1; k < people.length; k++) {
        const [a, b, c] = [people[i], people[j], people[k]]
        if (union(a, b) >= 2 && union(a, c) >= 2 && union(b, c) >= 2 && union(a, b, c) >= 3) return [a, b, c]
      }
  return null
}

/**
 * Grant whatever this account is owed and has not had — the trial first, a
 * referral month after it (banked until the trial is over) — under the
 * account's own lock, Plus read again inside it: two requests at once grant
 * one thing at most.
 */
async function grantOwed(userId: string, flippedAt: Date | null, now: Date): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plus-owed:${userId}`}, 0))`
    if (await hasPlus(userId, now, tx)) return

    if (flippedAt && (await trialEligible(tx, userId, flippedAt))) {
      const ref = trialRef(userId)
      const until = new Date(now.getTime() + PLUS.TRIAL_DAYS * DAY_MS)
      if (await grantPlusOnce(tx, { userId, ref, startsAt: now, expiresAt: until })) {
        await audit(tx, userId, "entitlement.trial", ref, until, { flippedAt: flippedAt.toISOString() })
        return
      }
    }

    const yearAgo = new Date(now.getTime() - 365 * DAY_MS)
    if ((await plusGrantsSince(tx, userId, REFERRAL_REF_PREFIX, yearAgo)) >= PLUS.REFERRAL_MONTHS_PER_YEAR) return
    const invitees = await referralTriple(tx, userId, now)
    if (!invitees) return
    const ref = referralRef(userId, invitees)
    const until = addMonths(now, PLUS.REFERRAL_MONTHS)
    if (!(await grantPlusOnce(tx, { userId, ref, startsAt: now, expiresAt: until }))) return
    const marked = await tx.referrals.updateMany({
      where: { inviter_id: userId, invitee_id: { in: invitees }, rewarded_at: null },
      data: { rewarded_at: now, rewarded_ref: ref },
    })
    if (marked.count !== invitees.length) throw new Error("referral invitees changed while being rewarded")
    await audit(tx, userId, "entitlement.referral", ref, until, { invitees: invitees.length })
  })
}

async function audit(
  tx: Prisma.TransactionClient,
  userId: string,
  action: "entitlement.trial" | "entitlement.referral",
  ref: string,
  expiresAt: Date,
  details: Record<string, string | number>
) {
  await tx.audit_logs.create({
    data: {
      action: action,
      resource: "user",
      resource_id: userId,
      details: { product: "plus", ref: ref, expiresAt: expiresAt.toISOString(), ...details },
    },
  })
}

/**
 * The one Blendn+ gate: is Plus needed here and missing? False in a city's
 * launch season, and false for anyone holding Plus or a live Night Pass.
 * Before answering yes, pays out a trial or referral month that is owed —
 * then reads again, so a twin request that granted it a moment earlier is
 * seen too.
 *
 * Read from the database every time: no JWT claim, header, query flag or
 * cached response says who has Plus (test plan MN-I10, SEC-15).
 */
export async function plusRequired(userId: string, city: string | null, now: Date = new Date()): Promise<boolean> {
  const gate = plusGateFor(city)
  if (!gate.gated) return false
  if (await hasPlus(userId, now)) return false
  await grantOwed(userId, gate.flippedAt, now)
  return !(await hasPlus(userId, now))
}

/**
 * How many of this person's nights are locked behind Plus: those beyond the
 * latest `FREE_HISTORY_NIGHTS`, when Plus is gated in the city of their latest
 * night and they have none. 0 otherwise.
 */
export async function lockedNights(userId: string, totalNights: number, now: Date = new Date()): Promise<number> {
  if (totalNights <= PLUS.FREE_HISTORY_NIGHTS || !plusGatedAnywhere()) return 0
  const [latest] = await attendedEventIds(userId, { limit: 1, skip: 0 })
  if (!latest) return 0
  const event = await db.events.findUnique({ where: { id: latest.event_id }, select: { city: true } })
  return (await plusRequired(userId, event?.city ?? null, now)) ? totalNights - PLUS.FREE_HISTORY_NIGHTS : 0
}

/**
 * Remember who brought this person: the first invite link they used, when
 * they are new to Blendn (`REFERRAL_NEW_ACCOUNT_DAYS`). Never themselves; a
 * second link changes nothing. The caller has already held them to the
 * participation gate (onboarded, 18+). This records; it grants nothing.
 */
export async function recordReferral(inviteeId: string, inviterId: string, now: Date = new Date()): Promise<void> {
  if (inviteeId === inviterId) return
  const newcomer = await db.user.findFirst({
    where: { id: inviteeId, deletedAt: null, createdAt: { gte: new Date(now.getTime() - PLUS.REFERRAL_NEW_ACCOUNT_DAYS * DAY_MS) } },
    select: { id: true },
  })
  if (!newcomer) return
  await db.referrals.createMany({ data: [{ invitee_id: inviteeId, inviter_id: inviterId }], skipDuplicates: true })
}
