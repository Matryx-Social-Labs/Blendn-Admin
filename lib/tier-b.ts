import { db } from "@/lib/db"

/**
 * Changing your own Tier B facts — languages, home state, sign, field of work
 * (plan v2 §8.5) — and why it is limited (step 10 review H1).
 *
 * Each is printed on a card when you share it with someone. Changing yours
 * again and again, and reading which cards light up, would learn every card's
 * Tier B one edit at a time — the one-fact budget defeated from the viewer's
 * side. Two defences, both here:
 *
 * 1. **Stamped.** Every effective change sets `tier_b_changed_at`; a room uses
 *    a viewer's own Tier B only if it predates their check-in
 *    (`viewerTierB` in lib/overlaps.ts).
 * 2. **Three a day, counted in the database.** `tier_b_changes` keeps the
 *    times of the last changes; a fourth inside 24 hours is refused. Per
 *    person, per change (never per request or per IP), and atomic: the check
 *    and the record are one conditional UPDATE, so two requests at once cannot
 *    both take the last one. Not the Redis limiter: that degrades to a
 *    per-process counter when Redis is down, and a limit that resets on
 *    restart or splits across replicas is not one. A database that is down
 *    refuses the write anyway — this fails closed by construction.
 *
 * `__tests__/tier-b-one-writer.test.ts` keeps every write of these columns in
 * the profile route, so no other path can change them without the stamp and
 * the count.
 */

export const TIER_B_CHANGES_PER_DAY = 3
const DAY_MS = 24 * 60 * 60 * 1000

export const TIER_B_REFUSAL =
  "You can change your languages, home state, sign or field of work three times a day. Try again tomorrow."

export interface TierBFacts {
  languages: readonly string[]
  home_state: string | null
  sun_sign: string | null
  sign_system: string | null
  work_field: string | null
}

/**
 * Whether a request changes any Tier B fact. `undefined` means not sent. A
 * value equal to the stored one is no change — re-saving a profile is never
 * counted and never refused. A sign is its slug and its calendar: switching
 * Western to rashi alone is a change.
 */
export function changesTierB(
  sent: Partial<{ [K in keyof TierBFacts]: TierBFacts[K] | undefined }>,
  stored: TierBFacts | null | undefined
): boolean {
  const was: TierBFacts = stored ?? { languages: [], home_state: null, sun_sign: null, sign_system: null, work_field: null }
  return (
    (sent.languages !== undefined && JSON.stringify([...sent.languages].sort()) !== JSON.stringify([...was.languages].sort())) ||
    (sent.home_state !== undefined && sent.home_state !== was.home_state) ||
    (sent.sun_sign !== undefined && sent.sun_sign !== was.sun_sign) ||
    (sent.sign_system !== undefined && sent.sign_system !== was.sign_system) ||
    (sent.work_field !== undefined && sent.work_field !== was.work_field)
  )
}

/**
 * Take one of today's changes for this person, or false when all three are
 * spent. Records the change and stamps `tier_b_changed_at` in the same
 * statement. Call it after every other refusal, right before the write, so a
 * refused save never spends one.
 */
export async function claimTierBChange(userId: string, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - DAY_MS)
  const updated = await db.$executeRaw`
    UPDATE profiles
       SET tier_b_changes = array_append(
             ARRAY(SELECT t FROM unnest(tier_b_changes) AS t WHERE t > ${since}),
             ${now}::timestamptz
           ),
           tier_b_changed_at = ${now}
     WHERE id = ${userId}
       AND (SELECT count(*) FROM unnest(tier_b_changes) AS t WHERE t > ${since}) < ${TIER_B_CHANGES_PER_DAY}
  `
  return updated === 1
}
