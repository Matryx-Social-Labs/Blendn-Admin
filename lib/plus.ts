import "server-only"

import { Prisma } from "@prisma/client"

import { attendedEventIds } from "./attendee-counts"
import { ATTENDED } from "./counting"
import { db } from "./db"
import { addMonths, grantPlusOnce, hasEntitlement } from "./entitlements"
import { plusGatedAnywhere, plusGatedIn } from "./env"

/**
 * Blendn+ for attendees (plan v2 §9.3), configured here and nowhere else.
 *
 * What Plus is: staying live while you're here, your full night history (free
 * keeps the last 3), partner perks, crew extras. Every one of them asks
 * `plusRequired` on the server. Perks and crew extras do not exist yet; they
 * call it when they land (SCRUM-584).
 *
 * What is NEVER sold (owner ruling 2026-10-01): who liked you, more than the
 * caps allow, seeing a venue without going live, a reveal bypass, boosting.
 * `__tests__/plus-gate-boundary.test.ts` holds the list of files allowed to
 * ask, so none of those can quietly start asking.
 *
 * Where it is sold: `PLUS_GATING` (lib/env.ts) names the gated cities. A city
 * not named is in its launch season, everything unlocked.
 *
 * What we give away, once each, at the moment it matters — the first time a
 * person would be refused in a gated city:
 *   - **the trial**: 14 days, to anyone who came out in the last 90 days. The
 *     plan's "when the gate flips, active users get a 14-day trial", taken
 *     lazily: nobody has to run anything on the day a city flips, an inactive
 *     person gets none, and each person's 14 days start when they first use it.
 *   - **the referral month**: once 3 people who signed up through your invite
 *     link (a new account, onboarded and 18+ — the friend-request route's own
 *     gate) have checked in somewhere after joining. Banked until then. A
 *     request sent or accepted earns nothing; a check-in at a real place does,
 *     and only once per person, ever, for one inviter.
 * Both are rows with a fixed `external_ref` per person, so a second attempt —
 * or two at once — grants nothing more, and each is audited in the same
 * transaction as its row (a refused audit takes the grant with it).
 */
export const PLUS = {
  /** Nights of history everyone keeps; older ones are Plus. */
  FREE_HISTORY_NIGHTS: 3,
  /** A Night Pass: Plus for this long from purchase, or from the end of one still running (D-16). */
  NIGHT_PASS_MS: 24 * 60 * 60 * 1000,
  TRIAL_DAYS: 14,
  /** "Active": came out at least once in this many days. */
  TRIAL_ACTIVE_DAYS: 90,
  REFERRAL_FRIENDS: 3,
  REFERRAL_MONTHS: 1,
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

const DAY_MS = 24 * 60 * 60 * 1000
const user = (id: string) => ({ kind: "user" as const, id })

/** The once-per-person references. One trial, one referral month, ever. */
export const trialRef = (userId: string) => `plus-trial:${userId}`
export const referralRef = (userId: string) => `plus-referral:${userId}`

/** Has this person checked in anywhere since `since`? */
async function cameOutSince(userId: string, since: Date): Promise<boolean> {
  const [row] = await db.$queryRaw<{ yes: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM event_check_ins
       WHERE user_id = ${userId}
         AND kind = 'attendee'
         AND status::text IN (${Prisma.join(ATTENDED)})
         AND check_in_time >= ${since}
    ) AS yes`
  return row?.yes === true
}

/** How many people who joined through this person's link have checked in since joining. Each counts once. */
export async function referredFriendsWhoCameOut(inviterId: string): Promise<number> {
  const [row] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM referrals r
     WHERE r.inviter_id = ${inviterId}
       AND EXISTS (
         SELECT 1 FROM event_check_ins ci
          WHERE ci.user_id = r.invitee_id
            AND ci.kind = 'attendee'
            AND ci.status::text IN (${Prisma.join(ATTENDED)})
            AND ci.check_in_time >= r.created_at
       )`
  return row?.n ?? 0
}

/** One of our own grants, once per `ref`, with its audit row in the same transaction. True when this call granted it. */
async function grantAudited(
  userId: string,
  ref: string,
  startsAt: Date,
  expiresAt: Date,
  action: "entitlement.trial" | "entitlement.referral",
  details: Record<string, number> = {}
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    if (!(await grantPlusOnce(tx, { userId, ref, startsAt, expiresAt }))) return false
    await tx.audit_logs.create({
      data: {
        action: action,
        resource: "user",
        resource_id: userId,
        details: { product: "plus", ref: ref, expiresAt: expiresAt.toISOString(), ...details },
      },
    })
    return true
  })
}

/** Grant whatever this person is owed and has not had: the trial first, then the referral month (banked until the trial is over). */
async function grantOwed(userId: string, now: Date): Promise<boolean> {
  if (await cameOutSince(userId, new Date(now.getTime() - PLUS.TRIAL_ACTIVE_DAYS * DAY_MS))) {
    const until = new Date(now.getTime() + PLUS.TRIAL_DAYS * DAY_MS)
    if (await grantAudited(userId, trialRef(userId), now, until, "entitlement.trial")) return true
  }
  const friends = await referredFriendsWhoCameOut(userId)
  if (friends >= PLUS.REFERRAL_FRIENDS) {
    const until = addMonths(now, PLUS.REFERRAL_MONTHS)
    if (await grantAudited(userId, referralRef(userId), now, until, "entitlement.referral", { friends })) return true
  }
  return false
}

/**
 * Does this person hold Blendn+ now: the subscription (or one of our grants),
 * or a live Night Pass — 24 hours of Plus. The rule that a pass counts as Plus
 * lives here and only here; `hasEntitlement` answers for exactly the product it
 * is asked about.
 */
export async function hasPlus(userId: string, now: Date = new Date()): Promise<boolean> {
  const [plus, pass] = await Promise.all([
    hasEntitlement(user(userId), "plus", {}, now),
    hasEntitlement(user(userId), "night_pass", {}, now),
  ])
  return plus || pass
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
  if (!plusGatedIn(city)) return false
  if (await hasPlus(userId, now)) return false
  await grantOwed(userId, now)
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
