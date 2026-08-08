import { db } from "@/lib/db"

/**
 * Whether meeting this person went well, for the people who actually met them.
 *
 * The product asks strangers to meet strangers. Attendance says a night
 * happened and connections say people paired up; neither says whether the
 * meeting was a good experience, which is the risk being asked of everyone and
 * the one thing currently taken on faith.
 *
 * ## Who this is for
 *
 * **Moderation, not attendees. This is a safety constraint, not a preference.**
 *
 * The person most likely to rate someone badly is the person who felt least safe
 * with them. Make that rating visible and you have told the man that the woman
 * who met him rated him down — at an event where he knows who she is, has her
 * pseudonym, and may still be in the room. The feature intended to protect her
 * becomes the thing that exposes her.
 *
 * That is the reason. The secondary ones are real but would not on their own
 * justify the constraint: a visible number turns a safety mechanism into a
 * status game, gives people a reason to trade ratings, and makes one bad night
 * follow someone permanently.
 *
 * **No endpoint returns a trust signal to another user, and none may be added.**
 * `__tests__/trust-not-exposed.test.ts` enforces it, because this is exactly the
 * kind of rule that erodes when someone wants a "verified" badge.
 *
 * A known limit worth stating rather than hiding: at a small event with one
 * connection, acting visibly on a report can identify the reporter by
 * elimination. Moderation has to weigh that; the schema cannot.
 *
 * ## Derived, never stored
 *
 * No `trust_score` column. `events.current_capacity` was a stored number every
 * write path had to maintain, it drifted, and two bugs shipped from it in one
 * day. A reputation column would be the same shape with worse consequences.
 *
 * ## Harassment never averages away
 *
 * A harassment report is carried separately and is never folded into the mean.
 * Four glowing ratings and one harassment report is not a 4.2 — it is a
 * harassment report, and any design where volume dilutes it is wrong.
 */

/**
 * Below this many ratings there is no signal, only opinions.
 *
 * Two people can dislike anyone. The band stays `unrated` until there is enough
 * to distinguish a pattern from a bad night, and the raw counts are still
 * available to a human who wants to look.
 */
export const MIN_RATINGS = 4

export type TrustBand = "unrated" | "good" | "mixed" | "poor"

export interface TrustSignal {
  ratings: number
  /** Mean of the 1–5 scores. Null until `MIN_RATINGS`. */
  average: number | null
  band: TrustBand
  /**
   * Reports by kind, harassment included. Always present regardless of volume —
   * a single report is worth surfacing on its own.
   */
  issues: Record<string, number>
  /** Any harassment report at all. Never diluted by good ratings. */
  hasHarassmentReport: boolean
}

/** The band, given enough ratings to have one. */
export function trustBand(count: number, average: number | null): TrustBand {
  if (count < MIN_RATINGS || average === null) return "unrated"
  if (average >= 4) return "good"
  if (average >= 3) return "mixed"
  return "poor"
}

export async function getTrustSignal(userId: string): Promise<TrustSignal> {
  const rows = await db.peer_ratings.findMany({
    where: { rated_id: userId },
    select: { rating: true, issue: true },
  })

  const issues: Record<string, number> = {}
  let total = 0
  for (const r of rows) {
    total += r.rating
    if (r.issue !== "none") issues[r.issue] = (issues[r.issue] ?? 0) + 1
  }

  const average = rows.length >= MIN_RATINGS ? Math.round((total / rows.length) * 10) / 10 : null

  return {
    ratings: rows.length,
    average,
    band: trustBand(rows.length, average),
    issues,
    hasHarassmentReport: (issues.harassment ?? 0) > 0,
  }
}

/**
 * The people you may rate for an event, and have not yet.
 *
 * Only those you **connected** with — a mutual like, meaning both people opted
 * in. Rating anyone who merely shared a room is a review-bombing surface and a
 * way to punish someone for declining.
 *
 * Returns an empty list before the event ends: asked during the night, a rating
 * is leverage; asked afterwards, it is reflection.
 */
export async function ratablePeers(
  eventId: string,
  raterId: string,
  now: Date = new Date()
): Promise<string[]> {
  const event = await db.events.findUnique({
    where: { id: eventId },
    select: { end_time: true },
  })
  if (!event || event.end_time > now) return []

  const [mine, theirs, already] = await Promise.all([
    db.event_likes.findMany({
      where: { event_id: eventId, liker_id: raterId },
      select: { liked_id: true },
    }),
    db.event_likes.findMany({
      where: { event_id: eventId, liked_id: raterId },
      select: { liker_id: true },
    }),
    db.peer_ratings.findMany({
      where: { event_id: eventId, rater_id: raterId },
      select: { rated_id: true },
    }),
  ])

  const likedBack = new Set(theirs.map((l) => l.liker_id))
  const rated = new Set(already.map((r) => r.rated_id))

  return mine
    .map((l) => l.liked_id)
    .filter((id) => likedBack.has(id) && !rated.has(id))
}
