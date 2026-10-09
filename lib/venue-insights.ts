import "server-only"

import { db } from "./db"
import { discloseBreakdown, discloseHeadcount } from "./disclosure"
import { hasEntitlement } from "./entitlements"

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
 * Regulars and one-timers are two parts of one whole, so they go through
 * `discloseBreakdown`: neither part is shown when either is under the floor,
 * or the whole minus the shown part would give the hidden one back.
 *
 * ## From the claim on; the past only in aggregate
 *
 * The owner's figures start at `claimed_at` (owner's ruling 1, SCRUM-355):
 * the recent window is clamped to it. What happened before the claim is never
 * opened operationally; with Pro it arrives here as three totals — nights,
 * people, since when — and nothing that names a night or a person.
 *
 * A "night" is the venue's day (`day_reset_hour`, 06:00 by default): somebody
 * in at 01:00 is still at last night's, as for venue days.
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const LISTED_WINDOW_DAYS = 30
export const PRO_WINDOW_DAYS = 365

/** cells[day][slot]: Monday-first, slots morning / afternoon / evening / late. Null: held back (1–4 people). */
export type PeopleGrid = (number | null)[][]

export interface VenueRegulars {
  /** Distinct guests in the window, or null under the floor. */
  visitors: number | null
  /** Guests on two or more nights; null when either part is under the floor. */
  regulars: number | null
  oneTimers: number | null
  /** Regulars as a share of guests, when both parts are shown. */
  sharePct: number | null
}

export interface VenueInsight {
  window: "30d" | "12m"
  /** The window's start: the later of its length and the claim. */
  from: string
  people: PeopleGrid
  regulars: VenueRegulars
}

export interface PreClaimHistory {
  /** Nights with anyone checked in before the claim. Nights are not people. */
  nights: number
  /** Distinct guests across them, or null under the floor. */
  people: number | null
  /** The first such night's month, "2025-03", or null with none. */
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

/** Mon = 0 … Sun = 6, from Postgres' ISO weekday. Slot by local hour, as the events heatmap. */
function emptyGrid(): number[][] {
  return Array.from({ length: 7 }, () => [0, 0, 0, 0])
}

async function peopleGrid(v: VenueClock, from: Date, to: Date): Promise<PeopleGrid> {
  // any-kind: a venue's insights count its guests on hosts' nights and in its own live room alike.
  const rows = await db.$queryRaw<{ dow: number; slot: number; people: number }[]>`
    SELECT extract(isodow FROM c.check_in_time AT TIME ZONE ${v.timezone})::int - 1 AS dow,
           CASE
             WHEN extract(hour FROM c.check_in_time AT TIME ZONE ${v.timezone}) < 12 THEN 0
             WHEN extract(hour FROM c.check_in_time AT TIME ZONE ${v.timezone}) < 17 THEN 1
             WHEN extract(hour FROM c.check_in_time AT TIME ZONE ${v.timezone}) < 22 THEN 2
             ELSE 3
           END AS slot,
           count(DISTINCT c.user_id)::int AS people
      FROM event_check_ins c
      JOIN events e ON e.id = c.event_id
     WHERE e.venue_id = ${v.id}::uuid
       AND e.deleted_at IS NULL
       AND c.kind = 'attendee'
       AND c.status IN ('checked_in', 'checked_out')
       AND c.check_in_time >= ${from} AND c.check_in_time < ${to}
     GROUP BY 1, 2`
  const grid = emptyGrid()
  for (const r of rows) grid[r.dow][r.slot] = r.people
  return grid.map((day) => day.map((n) => discloseHeadcount(n)))
}

async function regularsIn(v: VenueClock, from: Date, to: Date): Promise<VenueRegulars> {
  // any-kind: a venue's insights count its guests on hosts' nights and in its own live room alike.
  const [row] = await db.$queryRaw<{ visitors: number; regulars: number }[]>`
    SELECT count(*)::int AS visitors, count(*) FILTER (WHERE nights >= 2)::int AS regulars
      FROM (
        SELECT c.user_id,
               count(DISTINCT ((c.check_in_time AT TIME ZONE ${v.timezone}) - make_interval(hours => ${v.day_reset_hour}))::date) AS nights
          FROM event_check_ins c
          JOIN events e ON e.id = c.event_id
         WHERE e.venue_id = ${v.id}::uuid
           AND e.deleted_at IS NULL
           AND c.kind = 'attendee'
           AND c.status IN ('checked_in', 'checked_out')
           AND c.check_in_time >= ${from} AND c.check_in_time < ${to}
         GROUP BY c.user_id
      ) guests`
  const visitors = row?.visitors ?? 0
  const regulars = row?.regulars ?? 0
  const parts = discloseBreakdown([regulars, visitors - regulars])
  const [shownRegulars, shownOnce] = parts.cells
  return {
    visitors: discloseHeadcount(visitors),
    regulars: shownRegulars,
    oneTimers: shownOnce,
    sharePct: shownRegulars !== null && shownOnce !== null ? Math.round((shownRegulars / visitors) * 100) : null,
  }
}

/** The venue's nights before its claim, as three totals (Pro only). */
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
  return {
    nights: row?.nights ?? 0,
    people: discloseHeadcount(row?.people ?? 0),
    since: row?.first ? row.first.toISOString().slice(0, 7) : null,
  }
}

/**
 * The insights a venue's plan includes, for its owner (or an admin looking at
 * what the owner sees). Null for an unclaimed venue: there is nobody to show.
 */
export async function venueInsights(venueId: string, now: Date = new Date()): Promise<VenueInsightsView | null> {
  const v = await db.venues.findUnique({
    where: { id: venueId },
    select: { id: true, timezone: true, day_reset_hour: true, claimed_at: true, owner_org_id: true },
  })
  if (!v || !v.owner_org_id || !v.claimed_at) return null
  const pro = await hasEntitlement({ kind: "venue", id: venueId }, "venue_pro", {}, now)
  const days = pro ? PRO_WINDOW_DAYS : LISTED_WINDOW_DAYS
  const windowStart = new Date(now.getTime() - days * DAY_MS)
  const from = windowStart > v.claimed_at ? windowStart : v.claimed_at
  const [people, regulars, preClaim] = await Promise.all([
    peopleGrid(v, from, now),
    regularsIn(v, from, now),
    pro ? preClaimHistory({ ...v, claimed_at: v.claimed_at }) : null,
  ])
  return {
    plan: pro ? "pro" : "listed",
    recent: { window: pro ? "12m" : "30d", from: from.toISOString(), people, regulars },
    preClaim,
  }
}
