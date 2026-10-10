import "server-only"

import { db } from "./db"
import { discloseBreakdown, discloseHeadcount, MIN_CELL } from "./disclosure"
import { hasEntitlement } from "./entitlements"
import { venueDayBounds } from "./venue-day"

/**
 * A venue's own insights, by plan (plan v2 §9.1b; audit §2.2, §6.2).
 *
 *   - **Listed** (free): the last 30 days — people by day and slot, how many
 *     came, and how many came back (regulars).
 *   - **Venue Pro**: the same over 12 months, and the venue's history before
 *     its claim, as totals only.
 *
 * ## Nothing paid is computed for a venue that has not paid
 *
 * `venueInsights` asks `hasEntitlement` first and runs the 12-month and
 * pre-claim queries only when it answers yes. A locked panel draws
 * `lib/sample-analytics.ts`, never these figures under a blur.
 *
 * ## Counts, never people
 *
 * Every figure is a count of distinct guests (staff are left out), floored at
 * `MIN_CELL` (`lib/disclosure.ts`): a cell under 5 is null, never a number.
 *
 * The headline — guests, regulars, the returning share — counts only the
 * guests in the cells the grid shows. Counted over every row, "guests" minus
 * the shown cells gave a held-back cell straight back (24 − 21 = 3, step 17
 * review C1). Regulars and one-timers are two parts of that whole, so they go
 * through `discloseBreakdown`: neither part is shown when either is under
 * the floor, or the whole minus the shown part would give the hidden one back.
 *
 * ## Whole nights, so a figure does not move while you watch
 *
 * The window ends at the start of the venue's current day (its 06:00 reset),
 * never at `now`: a count that grew as each person arrived could be differenced
 * between two reloads (review M9). It moves once a day, by a whole night.
 *
 * ## From the claim on; the past only in aggregate
 *
 * The owner's figures start at `claimed_at` (owner's ruling 1, SCRUM-355):
 * the recent window is clamped to it. What happened before the claim is never
 * opened operationally; with Pro it arrives here as three totals — nights,
 * people, since when — and nothing that names a night or a person.
 *
 * A "night" is the venue's day (`day_reset_hour`, 06:00 by default): somebody
 * in at 01:00 is still at last night's, as for venue days, and in its late
 * slot — the boundary the events heatmap uses too.
 *
 * One pass over the window's rows for the grid and the headline (review M5),
 * and the answer is kept for a few minutes per venue, plan and window end.
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const LISTED_WINDOW_DAYS = 30
export const PRO_WINDOW_DAYS = 365
/** How long an answer is reused. The window moves once a day; a grant changes the key. */
const CACHE_MS = 10 * 60 * 1000
const CACHE_MAX = 500

/** cells[day][slot]: Monday-first, slots morning / afternoon / evening / late. Null: held back (1–4 people). */
export type PeopleGrid = (number | null)[][]

export interface VenueRegulars {
  /** Distinct guests in the slots the grid shows, or null when none is shown. */
  visitors: number | null
  /** Of them, guests on two or more nights; null when either part is under the floor. */
  regulars: number | null
  oneTimers: number | null
  /** Regulars as a share of those guests, when both parts are shown. */
  sharePct: number | null
}

export interface VenueInsight {
  window: "30d" | "12m"
  /** The window's start: the later of its length and the claim. */
  from: string
  /** The window's end: the start of the venue's current day. */
  to: string
  people: PeopleGrid
  regulars: VenueRegulars
}

export interface PreClaimHistory {
  /** Nights with anyone checked in before the claim; null with the guests under the floor. */
  nights: number | null
  /** Distinct guests across them, or null under the floor. */
  people: number | null
  /** The first such night's month, "2025-03"; null with the guests under the floor. */
  since: string | null
}

export interface VenueInsightsView {
  plan: "listed" | "pro"
  recent: VenueInsight
  /** Pro only, and only for a claimed venue. */
  preClaim: PreClaimHistory | null
}

interface VenueClock {
  id: string
  timezone: string
  day_reset_hour: number
  claimed_at: Date | null
}

/**
 * The grid and the headline in one pass (the review's tested SQL). A row's
 * night is its local time less the reset hour; its slot is late before the
 * reset, then morning / afternoon / evening / late by local hour. The headline
 * reads only the cells at or above the floor.
 */
async function insightIn(v: VenueClock, from: Date, to: Date): Promise<Pick<VenueInsight, "people" | "regulars">> {
  // any-kind: a venue's insights count its guests on hosts' nights and in its own live room alike.
  const rows = await db.$queryRaw<
    { part: "cell" | "guests"; dow: number | null; slot: number | null; people: number | null; visitors: number | null; regulars: number | null }[]
  >`
    WITH ci AS MATERIALIZED (
      SELECT c.user_id,
             ((c.check_in_time AT TIME ZONE ${v.timezone}) - make_interval(hours => ${v.day_reset_hour}))::date AS night,
             extract(hour FROM c.check_in_time AT TIME ZONE ${v.timezone})::int AS hour
        FROM events e
        JOIN event_check_ins c ON c.event_id = e.id
       WHERE e.venue_id = ${v.id}::uuid
         AND e.deleted_at IS NULL
         AND c.kind = 'attendee'
         AND c.status IN ('checked_in', 'checked_out')
         AND c.check_in_time >= ${from} AND c.check_in_time < ${to}
    ), placed AS (
      SELECT user_id, night,
             extract(isodow FROM night)::int - 1 AS dow,
             CASE
               WHEN hour < ${v.day_reset_hour} THEN 3
               WHEN hour < 12 THEN 0
               WHEN hour < 17 THEN 1
               WHEN hour < 22 THEN 2
               ELSE 3
             END AS slot
        FROM ci
    ), cell AS (
      SELECT dow, slot, count(DISTINCT user_id)::int AS people FROM placed GROUP BY dow, slot
    ), shown AS (
      SELECT dow, slot FROM cell WHERE people >= ${MIN_CELL}
    ), guests AS (
      SELECT p.user_id, count(DISTINCT p.night) AS nights
        FROM placed p JOIN shown USING (dow, slot)
       GROUP BY p.user_id
    )
    SELECT 'cell' AS part, dow, slot, people, NULL::int AS visitors, NULL::int AS regulars FROM cell
    UNION ALL
    SELECT 'guests', NULL, NULL, NULL, count(*)::int, (count(*) FILTER (WHERE nights >= 2))::int FROM guests`
  const grid = Array.from({ length: 7 }, () => [0, 0, 0, 0])
  let visitors = 0
  let regulars = 0
  for (const r of rows) {
    if (r.part === "cell" && r.dow !== null && r.slot !== null) grid[r.dow][r.slot] = r.people ?? 0
    else if (r.part === "guests") {
      visitors = r.visitors ?? 0
      regulars = r.regulars ?? 0
    }
  }
  const [shownRegulars, shownOnce] = discloseBreakdown([regulars, visitors - regulars]).cells
  return {
    people: grid.map((day) => day.map((n) => discloseHeadcount(n))),
    regulars: {
      visitors: visitors > 0 ? discloseHeadcount(visitors) : null,
      regulars: shownRegulars,
      oneTimers: shownOnce,
      sharePct: shownRegulars !== null && shownOnce !== null ? Math.round((shownRegulars / visitors) * 100) : null,
    },
  }
}

/** The venue's nights before its claim, as three totals (Pro only); all three withheld with the guests under the floor. */
async function preClaimHistory(v: VenueClock & { claimed_at: Date }): Promise<PreClaimHistory> {
  // any-kind: a venue's insights count its guests on hosts' nights and in its own live room alike.
  const [row] = await db.$queryRaw<{ nights: number; people: number; first: Date | null }[]>`
    SELECT count(DISTINCT ((c.check_in_time AT TIME ZONE ${v.timezone}) - make_interval(hours => ${v.day_reset_hour}))::date)::int AS nights,
           count(DISTINCT c.user_id)::int AS people,
           min(c.check_in_time) AS first
      FROM event_check_ins c
      JOIN events e ON e.id = c.event_id
     WHERE e.venue_id = ${v.id}::uuid
       AND e.deleted_at IS NULL
       AND c.kind = 'attendee'
       AND c.status IN ('checked_in', 'checked_out')
       AND c.check_in_time < ${v.claimed_at}`
  const people = discloseHeadcount(row?.people ?? 0)
  // A night count beside a held-back guest count says how small those nights were.
  if (people === null) return { nights: null, people: null, since: null }
  return {
    nights: row?.nights ?? 0,
    people,
    since: people > 0 && row?.first ? row.first.toISOString().slice(0, 7) : null,
  }
}

const cache = new Map<string, { at: number; view: VenueInsightsView }>()

/**
 * The insights a venue's plan includes, for its owner, its organisation's
 * staff, or an admin looking at what they see. Null for an unclaimed venue:
 * there is nobody to show.
 */
export async function venueInsights(venueId: string, now: Date = new Date()): Promise<VenueInsightsView | null> {
  const v = await db.venues.findUnique({
    where: { id: venueId },
    select: { id: true, timezone: true, day_reset_hour: true, claimed_at: true, owner_org_id: true },
  })
  if (!v || !v.owner_org_id || !v.claimed_at) return null
  const pro = await hasEntitlement({ kind: "venue", id: venueId }, "venue_pro", {}, now)
  const to = venueDayBounds(v.timezone, v.day_reset_hour, now).start
  const key = `${venueId}:${pro ? "pro" : "listed"}:${to.toISOString()}:${v.claimed_at.toISOString()}`
  const hit = cache.get(key)
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.view

  const windowStart = new Date(to.getTime() - (pro ? PRO_WINDOW_DAYS : LISTED_WINDOW_DAYS) * DAY_MS)
  const from = windowStart > v.claimed_at ? windowStart : v.claimed_at
  const [recent, preClaim] = await Promise.all([
    from < to ? insightIn(v, from, to) : insightIn(v, to, to),
    pro ? preClaimHistory({ ...v, claimed_at: v.claimed_at }) : null,
  ])
  const view: VenueInsightsView = {
    plan: pro ? "pro" : "listed",
    recent: { window: pro ? "12m" : "30d", from: from.toISOString(), to: to.toISOString(), ...recent },
    preClaim,
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(key, { at: now.getTime(), view })
  return view
}
