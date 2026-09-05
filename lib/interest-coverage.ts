import { db } from "./db"

/**
 * Is matching actually able to work right now?
 *
 * ## The failure this exists to catch
 *
 * `lib/matching.ts` ranks on the structured `user_interests -> categories`
 * graph. Onboarding writes free text to `profiles.interests` instead, so the
 * graph is empty in production and every match card comes back with no shared
 * interests, for everyone. Nothing throws. The unit suite is green because
 * every test seeds interests. It went unnoticed for weeks.
 *
 * ## Why a row count is the wrong signal
 *
 * `SELECT count(*) FROM user_interests` goes non-zero the moment one person
 * picks one category, while the room is still entirely unmatchable. The number
 * that means something is: **of the people who actually turned up, what share
 * have enough interests to be ranked at all.**
 *
 * ## Thresholds
 *
 * Two interests is the floor for being rankable in a way that can produce an
 * overlap worth naming. One interest can match, but a card that says "you both
 * picked Music" in a room where everyone picked Music is noise -- and
 * `interestWeight` already scores that near zero.
 */
export const MIN_INTERESTS_TO_RANK = 2

/** How far back to look for "people who actually turned up". */
const WINDOW_DAYS = 7

/**
 * Below this share of rankable attendees, matching is not meaningfully working
 * even though nothing is erroring. Deliberately low: this is a "something is
 * badly wrong" alarm, not a quality target.
 */
const DEGRADED_BELOW = 0.2

export interface InterestCoverage {
  status: "ok" | "degraded" | "no_signal"
  /** Distinct users who checked in during the window. */
  checkedIn: number
  /** How many of them hold at least `MIN_INTERESTS_TO_RANK` categories. */
  rankable: number
  /** `rankable / checkedIn`, or null when nobody has checked in. */
  rankableShare: number | null
  minInterestsToRank: number
  windowDays: number
}

export async function interestCoverage(): Promise<InterestCoverage> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

  /*
   * One aggregate rather than two round trips, because this runs on a health
   * endpoint that gets POLLED — which is exactly why the shape below matters.
   *
   * The previous form joined against `SELECT user_id, COUNT(*) FROM
   * user_interests GROUP BY user_id`: an unscoped aggregate over the ENTIRE
   * interests table, computed in full on every poll, and then thrown away
   * except for the handful of users who checked in this week. `EXPLAIN`
   * confirmed it — `Seq Scan on user_interests` under a `HashAggregate`,
   * regardless of how narrow the window was.
   *
   * Scoping the interest lookup to those users first turns a whole-table
   * aggregate into an index probe per recent attendee, via
   * `user_interests_user_id_category_id_key`. The answer is identical; only
   * the work is different.
   *
   * `COUNT(ui.user_id)` rather than `COUNT(*)` in the inner query: the LEFT
   * JOIN produces one all-null row for somebody with no interests, and
   * `COUNT(*)` would count that row as one interest — quietly making every
   * profile look one interest richer than it is, which on a coverage metric is
   * the worst possible direction to be wrong in.
   */
  const [row] = await db.$queryRaw<{ checked_in: bigint; rankable: bigint }[]>`
    WITH recent AS (
      SELECT DISTINCT user_id
        FROM event_check_ins
       WHERE check_in_time >= ${since}
    ),
    held AS (
      SELECT r.user_id, COUNT(ui.user_id) AS n
        FROM recent r
        LEFT JOIN user_interests ui ON ui.user_id = r.user_id
    GROUP BY r.user_id
    )
    SELECT
      COUNT(*) AS checked_in,
      COUNT(*) FILTER (WHERE n >= ${MIN_INTERESTS_TO_RANK}) AS rankable
    FROM held
  `

  const checkedIn = Number(row?.checked_in ?? 0)
  const rankable = Number(row?.rankable ?? 0)

  // No check-ins is not a matching failure, it is a quiet week. Saying
  // "degraded" here would cry wolf every Monday morning and train people to
  // ignore this field.
  if (checkedIn === 0) {
    return {
      status: "no_signal",
      checkedIn,
      rankable,
      rankableShare: null,
      minInterestsToRank: MIN_INTERESTS_TO_RANK,
      windowDays: WINDOW_DAYS,
    }
  }

  const rankableShare = rankable / checkedIn

  return {
    status: rankableShare < DEGRADED_BELOW ? "degraded" : "ok",
    checkedIn,
    rankable,
    rankableShare: Math.round(rankableShare * 1000) / 1000,
    minInterestsToRank: MIN_INTERESTS_TO_RANK,
    windowDays: WINDOW_DAYS,
  }
}
