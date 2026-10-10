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
 *    person, per change (never per request or per IP), and atomic with the
 *    write itself (`writeTierB`, under the row's lock). Not the Redis limiter:
 *    that degrades to a per-process counter when Redis is down, and a limit
 *    that resets on restart or splits across replicas is not one. A database
 *    that is down refuses the write anyway — this fails closed by construction.
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
    (sent.languages !== undefined && JSON.stringify(normaliseLanguages(sent.languages)) !== JSON.stringify(normaliseLanguages(was.languages))) ||
    (sent.home_state !== undefined && sent.home_state !== was.home_state) ||
    (sent.sun_sign !== undefined && sent.sun_sign !== was.sun_sign) ||
    (sent.sign_system !== undefined && sent.sign_system !== was.sign_system) ||
    (sent.work_field !== undefined && sent.work_field !== was.work_field)
  )
}

/** The languages as stored: each once, in one order, so a reorder is no change. */
export const normaliseLanguages = (languages: readonly string[]): string[] => [...new Set(languages)].sort()

export type TierBWrite = "written" | "unchanged" | "refused" | "no_profile"

/**
 * Write a person's Tier B facts — the only writer of these columns once a
 * profile exists — and stamp and count the change, in one transaction under
 * the profile row's lock (`SELECT … FOR UPDATE`).
 *
 * The lock is the point (step 10 review, the rate-limit scan). Comparing the
 * request to a profile read earlier, and writing whatever was sent, let a
 * request that looked like "no change" against a stale read write a change
 * anyway: ten PUTs at once alternating Kerala and Goa changed the value over
 * and over, uncounted and unstamped. Here the read, the comparison, the count
 * and the write see one row version, and a second request waits for the first.
 * Nothing is reserved and refunded: the count and the write commit together or
 * not at all, and a database that cannot take the lock refuses the write —
 * closed by construction, no Redis involved.
 *
 * Only the fields sent are written; `undefined` is not sent. A sign is sent
 * with its calendar (the route refuses one without the other).
 */
export async function writeTierB(
  userId: string,
  sent: Partial<{ [K in keyof TierBFacts]: TierBFacts[K] | undefined }>,
  now: Date = new Date()
): Promise<TierBWrite> {
  const next = { ...sent, ...(sent.languages !== undefined && { languages: normaliseLanguages(sent.languages) }) }
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<(TierBFacts & { onboarded: boolean; tier_b_changes: Date[] })[]>`
      SELECT languages, home_state, sun_sign, sign_system, work_field, onboarded, tier_b_changes
        FROM profiles WHERE id = ${userId} FOR UPDATE`
    const current = rows[0]
    if (!current) return "no_profile"
    if (!changesTierB(next, current)) return "unchanged"

    // Onboarding's first answers are not counted: nobody is in a room before it.
    let changes: Date[] | undefined
    if (current.onboarded) {
      const recent = current.tier_b_changes.filter((t) => t.getTime() > now.getTime() - DAY_MS)
      if (recent.length >= TIER_B_CHANGES_PER_DAY) return "refused"
      changes = [...recent, now]
    }
    await tx.profiles.update({
      where: { id: userId },
      data: {
        ...(next.languages !== undefined && { languages: [...next.languages] }),
        ...(next.home_state !== undefined && { home_state: next.home_state }),
        ...(next.sun_sign !== undefined && { sun_sign: next.sun_sign }),
        ...(next.sign_system !== undefined && { sign_system: next.sign_system }),
        ...(next.work_field !== undefined && { work_field: next.work_field }),
        tier_b_changed_at: now,
        ...(changes && { tier_b_changes: changes }),
      },
    })
    return "written"
  })
}
