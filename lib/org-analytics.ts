import "server-only"

import { Prisma, type rsvp_status } from "@prisma/client"

import { analyticsAccess, mayOpenEvent, type AnalyticsAccess } from "./analytics-access"
import { planBadgeFor, type PlanDate } from "./billing"
import { ATTENDED } from "./counting"
import { db } from "./db"
import { discloseBreakdown, discloseRating, MIN_CELL } from "./disclosure"
import type { PacingPoint } from "./dashboard-types"
import { realEventsWhere } from "./event-kind"
import { buildPacing, pacingWindowDays } from "./pacing"

/**
 * The paid analytics an organisation buys (plan v2 §9.1b, audit §6.1): only
 * what is new. Everything shipped stays on the free screens and is not
 * repeated here.
 *
 * ## Nothing is computed for a caller who may not see it
 *
 * Both loaders take the access decision (`lib/analytics-access.ts`) and return
 * null before their first query when it says no. A locked screen is drawn from
 * `lib/sample-analytics.ts`; the organisation's numbers never reach a page,
 * blurred or otherwise (MN-I12).
 *
 * ## Every new figure is floored, and so is its complement
 *
 * A count of people needs `MIN_CELL` (5). A part of a known group — the
 * first-timers among the people who came, the share of a cohort that came
 * back, the people who left early — is shown only when BOTH it and the rest of
 * the group reach the floor (`heldPart`, through `discloseBreakdown`): "17 of
 * 20 were first-timers" would otherwise name the 3 who were not. A percentage
 * is shown only when its part was. Held back is `null`, and the screen says
 * "held back".
 *
 * ## What stays exact, and why
 *
 * Going, came and turn-up in the comparison are the organisation's own counts
 * of its own events, which its free event page already shows exactly
 * (`lib/event-overview.ts`, `lib/attendance.ts`). Flooring them here would
 * hide nothing and contradict that page.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const COMMITTED: rsvp_status[] = ["going", "maybe"]
/** Past events in the comparison: the most recent this many. */
const COMPARISON_LIMIT = 50
/** The pacing benchmark: the median of this many of your last events. */
export const PACING_MEDIAN_OF = 5
/** Leaving more than this before the end counts as leaving early. */
const LEFT_EARLY_MS = 30 * 60 * 1000
/** A quartile of fewer than this many stays sits on one or two people's times. */
const QUARTILE_FLOOR = 8
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

export type Range = "30d" | "90d" | "all"
export const RANGES: Range[] = ["30d", "90d", "all"]

export function parseRange(value: string | undefined): Range {
  return value === "30d" || value === "all" ? value : "90d"
}

function rangeStart(range: Range, now: Date): Date {
  if (range === "all") return new Date(0)
  return new Date(now.getTime() - (range === "30d" ? 30 : 90) * DAY_MS)
}

/** "2026-08": the IST month an instant falls in. */
function istMonth(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 7)
}

/** A plain count of people, at the minimum cell. */
export const held = (n: number): number | null => (n >= MIN_CELL ? n : null)

/**
 * A part of a known group, shown only when the part and the rest both reach
 * the floor. The rest is never shown beside it, so neither can be subtracted
 * from a total to recover the other.
 */
export const heldPart = (part: number, whole: number): number | null =>
  whole < MIN_CELL ? null : discloseBreakdown([part, whole - part]).cells[0]

const pct = (part: number | null, whole: number): number | null =>
  part === null || whole === 0 ? null : Math.round((part / whole) * 100)

/** Distinct (person, event) attendance at this organisation's real events. */
const attendanceCte = (orgId: string) => Prisma.sql`
  att AS (
    SELECT DISTINCT ci.user_id, ci.event_id, e.start_time
      FROM event_check_ins ci
      JOIN events e ON e.id = ci.event_id
     WHERE e.organizer_org_id = ${orgId}::uuid
       AND e.deleted_at IS NULL
       AND e.kind = 'event'
       AND ci.kind = 'attendee'
       AND ci.status = ANY(${ATTENDED}::check_in_status[])
  )`

/* -------------------------------------------------------------------------- */
/* Across events                                                               */
/* -------------------------------------------------------------------------- */

export interface ComparisonRow {
  eventId: string
  title: string
  startsAt: string
  going: number
  came: number
  turnUpPct: number | null
  firstTimePct: number | null
  medianStayMin: number | null
  rating: number | null
}

export interface CohortRow {
  /** "2026-08": the IST month of each person's first event here. */
  month: string
  people: number | null
  /** Per window: a percentage, null when held back, "open" while the window has not closed for everyone. */
  back: Record<"d30" | "d60" | "d90", number | null | "open">
}

export interface PacingVsMedian {
  title: string
  capacity: number | null
  windowDays: number
  points: PacingPoint[]
  median: PacingPoint[]
  basedOn: number
}

export interface OrgAnalytics {
  range: Range
  /**
   * The hero: of the first-timers in the monthly cohorts whose 90 days have
   * closed and whose 90-day cell is shown (under All time), the share back
   * within 90 days. Built only from cells the grid itself shows, so it can
   * never be differenced against them to recover a held-back one.
   */
  backWithin90: { pct: number | null; cohort: number | null; cohorts: number }
  comparison: ComparisonRow[]
  cohorts: CohortRow[]
  pacing: PacingVsMedian | null
}

interface RawCohort {
  month: string
  people: number
  e30: number
  b30: number
  e60: number
  b60: number
  e90: number
  b90: number
}

/** One window of one cohort row: open, held back, or a percentage. */
function cohortCell(people: number, eligible: number, back: number): number | null | "open" {
  if (eligible < people) return "open"
  return pct(heldPart(back, eligible), eligible)
}

function cohortRow(r: RawCohort): CohortRow {
  const shown = held(r.people)
  return {
    month: r.month,
    people: shown,
    back: {
      d30: shown === null ? null : cohortCell(r.people, r.e30, r.b30),
      d60: shown === null ? null : cohortCell(r.people, r.e60, r.b60),
      d90: shown === null ? null : cohortCell(r.people, r.e90, r.b90),
    },
  }
}

export async function orgAnalytics(
  access: AnalyticsAccess,
  range: Range,
  now: Date = new Date()
): Promise<OrgAnalytics | null> {
  if (!access.org) return null
  const orgId = access.orgId
  const from = rangeStart(range, now)

  const [comparison, rawCohorts, pacing] = await Promise.all([
    comparisonRows(orgId, from, now),
    // Every cohort, whatever the range: the range picks WHOLE months below, in
    // JS, so a boundary month can never be differenced between two ranges.
    db.$queryRaw<{ month: string; people: bigint; e30: bigint; b30: bigint; e60: bigint; b60: bigint; e90: bigint; b90: bigint }[]>`
      WITH ${attendanceCte(orgId)},
      first_seen AS (SELECT user_id, MIN(start_time) AS first_at FROM att GROUP BY user_id),
      firsts AS (
        SELECT a.user_id, f.first_at, MIN(a.start_time) FILTER (WHERE a.start_time > f.first_at) AS second_at
          FROM att a JOIN first_seen f USING (user_id)
      GROUP BY a.user_id, f.first_at
      )
      SELECT to_char(date_trunc('month', first_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month,
             count(*) AS people,
             count(*) FILTER (WHERE first_at <= ${new Date(now.getTime() - 30 * DAY_MS)}) AS e30,
             count(*) FILTER (WHERE first_at <= ${new Date(now.getTime() - 30 * DAY_MS)} AND second_at <= first_at + interval '30 days') AS b30,
             count(*) FILTER (WHERE first_at <= ${new Date(now.getTime() - 60 * DAY_MS)}) AS e60,
             count(*) FILTER (WHERE first_at <= ${new Date(now.getTime() - 60 * DAY_MS)} AND second_at <= first_at + interval '60 days') AS b60,
             count(*) FILTER (WHERE first_at <= ${new Date(now.getTime() - 90 * DAY_MS)}) AS e90,
             count(*) FILTER (WHERE first_at <= ${new Date(now.getTime() - 90 * DAY_MS)} AND second_at <= first_at + interval '90 days') AS b90
        FROM firsts
       WHERE first_at < ${now}
    GROUP BY 1
    ORDER BY 1 DESC
    `,
    pacingVsMedian(orgId, now),
  ])

  const all: RawCohort[] = rawCohorts.map((r) => ({
    month: r.month,
    people: Number(r.people),
    e30: Number(r.e30),
    b30: Number(r.b30),
    e60: Number(r.e60),
    b60: Number(r.b60),
    e90: Number(r.e90),
    b90: Number(r.b90),
  }))
  const firstMonth = istMonth(from)
  const cohorts = all.filter((r) => range === "all" || r.month >= firstMonth).map(cohortRow)

  // The hero pools the rows the All-time grid shows with a closed, shown 90-day cell.
  const pooled = all.filter((r) => {
    const row = cohortRow(r)
    return typeof row.back.d90 === "number"
  })
  const e90 = pooled.reduce((n, r) => n + r.e90, 0)
  const b90 = pooled.reduce((n, r) => n + r.b90, 0)

  return {
    range,
    backWithin90: { pct: pooled.length ? pct(b90, e90) : null, cohort: pooled.length ? e90 : null, cohorts: pooled.length },
    comparison,
    cohorts,
    pacing,
  }
}

async function comparisonRows(orgId: string, from: Date, now: Date): Promise<ComparisonRow[]> {
  const events = await db.events.findMany({
    where: {
      organizer_org_id: orgId,
      deleted_at: null,
      ...realEventsWhere,
      start_time: { gte: from },
      end_time: { lt: now },
    },
    orderBy: { start_time: "desc" },
    take: COMPARISON_LIMIT,
    select: { id: true, title: true, start_time: true },
  })
  if (events.length === 0) return []
  const ids = events.map((e) => e.id)

  const [going, firsts, stays, ratings] = await Promise.all([
    db.event_rsvps.groupBy({ by: ["event_id"], where: { event_id: { in: ids }, status: "going" }, _count: { _all: true } }),
    db.$queryRaw<{ event_id: string; came: bigint; first_timers: bigint }[]>`
      WITH ${attendanceCte(orgId)},
      firsts AS (SELECT user_id, MIN(start_time) AS first_at FROM att GROUP BY user_id)
      SELECT a.event_id, count(*) AS came, count(*) FILTER (WHERE a.start_time = f.first_at) AS first_timers
        FROM att a JOIN firsts f USING (user_id)
       WHERE a.event_id IN (${Prisma.join(ids)})
    GROUP BY a.event_id
    `,
    stayByEvent(ids),
    db.event_ratings.groupBy({ by: ["event_id"], where: { event_id: { in: ids } }, _avg: { rating: true }, _count: { _all: true } }),
  ])
  const goingBy = new Map(going.map((g) => [g.event_id, g._count._all]))
  const firstsBy = new Map(firsts.map((f) => [f.event_id, f]))
  const stayBy = new Map(stays.map((s) => [s.event_id, s]))
  const ratingBy = new Map(ratings.map((r) => [r.event_id, r]))

  return events.map((e) => {
    const came = Number(firstsBy.get(e.id)?.came ?? 0)
    const firstTimers = Number(firstsBy.get(e.id)?.first_timers ?? 0)
    const g = goingBy.get(e.id) ?? 0
    const stay = stayBy.get(e.id)
    const rating = ratingBy.get(e.id)
    return {
      eventId: e.id,
      title: e.title,
      startsAt: e.start_time.toISOString(),
      going: g,
      came,
      // As the event page computes it (lib/attendance.ts): against "going".
      turnUpPct: g === 0 ? null : Math.round((Math.min(came, g) / g) * 100),
      firstTimePct: pct(heldPart(firstTimers, came), came),
      medianStayMin: stay && Number(stay.people) >= MIN_CELL ? Math.round(Number(stay.p50) / 60) : null,
      rating:
        rating?._avg.rating === null || rating?._avg.rating === undefined
          ? null
          : discloseRating(Math.round(rating._avg.rating * 10) / 10, rating._count._all),
    }
  })
}

/** Per person, the time inside across their sessions; per event, the spread of it. */
async function stayByEvent(eventIds: string[]) {
  if (eventIds.length === 0) return []
  return db.$queryRaw<
    { event_id: string; people: bigint; p25: number; p50: number; p75: number; soft: bigint; left_early: bigint }[]
  >`
    WITH stay AS (
      SELECT ps.event_id, ps.user_id,
             SUM(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(ps.departed_at, ps.last_seen_at, ps.arrived_at) - ps.arrived_at)))) AS seconds,
             bool_or(ps.departed_source = 'sweeper') AS soft,
             MAX(COALESCE(ps.departed_at, ps.last_seen_at, ps.arrived_at)) AS left_at
        FROM presence_sessions ps
       WHERE ps.event_id IN (${Prisma.join(eventIds)})
         AND ps.kind = 'attendee'
    GROUP BY ps.event_id, ps.user_id
    )
    SELECT s.event_id,
           count(*) AS people,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY s.seconds) AS p25,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY s.seconds) AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY s.seconds) AS p75,
           count(*) FILTER (WHERE s.soft) AS soft,
           count(*) FILTER (WHERE s.left_at < e.end_time - ${`${LEFT_EARLY_MS / 1000} seconds`}::interval) AS left_early
      FROM stay s JOIN events e ON e.id = s.event_id AND e.kind = 'event'
  GROUP BY s.event_id
  `
}

/** The next event's RSVPs against the median of your last few, day by day. */
async function pacingVsMedian(orgId: string, now: Date): Promise<PacingVsMedian | null> {
  const scope = { organizer_org_id: orgId, deleted_at: null, ...realEventsWhere }
  const [next, past] = await Promise.all([
    db.events.findFirst({
      where: { ...scope, status: "published", start_time: { gte: now } },
      orderBy: { start_time: "asc" },
      select: {
        title: true,
        start_time: true,
        max_capacity: true,
        rsvps: { where: { status: { in: COMMITTED } }, select: { created_at: true } },
      },
    }),
    db.events.findMany({
      where: { ...scope, status: "published", start_time: { lt: now } },
      orderBy: { start_time: "desc" },
      take: PACING_MEDIAN_OF,
      select: { start_time: true, rsvps: { where: { status: { in: COMMITTED } }, select: { created_at: true } } },
    }),
  ])
  if (!next || past.length < 2) return null

  const daysOut = Math.max(0, Math.ceil((next.start_time.getTime() - now.getTime()) / DAY_MS))
  const windowDays = pacingWindowDays(daysOut)
  const curves = past.map((p) => buildPacing(p.rsvps, p.start_time, windowDays))
  const median = curves[0].map((point, i) => {
    const values = curves.map((c) => c[i].cumulative).sort((a, b) => a - b)
    const mid = Math.floor(values.length / 2)
    return {
      daysOut: point.daysOut,
      cumulative: values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2),
    }
  })
  return {
    title: next.title,
    capacity: next.max_capacity,
    windowDays,
    points: buildPacing(next.rsvps, next.start_time, windowDays),
    median,
    basedOn: past.length,
  }
}

/* -------------------------------------------------------------------------- */
/* One event (the Event Pass)                                                  */
/* -------------------------------------------------------------------------- */

/** One bar of the arrivals replay: one or more consecutive 10-minute slots. */
export interface ArrivalBar {
  from: string
  to: string
  people: number
}

export interface EventAnalytics {
  eventId: string
  people: number | null
  stay: {
    p50Min: number
    /** The middle half, shown only from `QUARTILE_FLOOR` stays. */
    quartiles: { p25Min: number; p75Min: number } | null
    leftEarlyPct: number | null
    softPct: number | null
  } | null
  /**
   * First arrivals in 10-minute slots, a slot under the floor merged into its
   * neighbour so every bar reaches 5 and the bars add up to the total. Empty
   * when fewer than 5 people's arrivals were recorded at all.
   */
  arrivals: ArrivalBar[]
  firstTimers: number | null
  returning: number | null
  /** App views → RSVPs, counting a view only before that person's RSVP, and nobody of the organisation's own. */
  funnel: { viewers: number | null; viewersWhoRsvpd: number | null; conversionPct: number | null }
}

const SLOT_MS = 10 * 60 * 1000

/** Merge consecutive slots until each bar reaches the floor; a short tail joins the last bar. */
export function mergeArrivals(slots: { at: Date; n: number }[]): ArrivalBar[] {
  type Bar = { from: number; to: number; people: number }
  const bars: Bar[] = []
  let open = null as Bar | null
  for (const slot of slots) {
    const at = slot.at.getTime()
    const next: Bar = open ? { from: open.from, to: at + SLOT_MS, people: open.people + slot.n } : { from: at, to: at + SLOT_MS, people: slot.n }
    if (next.people >= MIN_CELL) {
      bars.push(next)
      open = null
    } else {
      open = next
    }
  }
  const tail = open
  if (tail && bars.length) {
    const last = bars[bars.length - 1]
    bars[bars.length - 1] = { from: last.from, to: tail.to, people: last.people + tail.people }
  }
  return bars.map((b) => ({ from: new Date(b.from).toISOString(), to: new Date(b.to).toISOString(), people: b.people }))
}

export async function eventAnalytics(
  access: AnalyticsAccess,
  eventId: string
): Promise<EventAnalytics | null> {
  if (!mayOpenEvent(access, eventId)) return null
  const orgId = access.orgId
  const event = await db.events.findFirst({
    where: { id: eventId, organizer_org_id: orgId, deleted_at: null, ...realEventsWhere },
    select: { id: true, start_time: true, end_time: true },
  })
  if (!event) return null

  const [stay, slots, firsts, funnel] = await Promise.all([
    stayByEvent([eventId]),
    db.$queryRaw<{ bucket: Date; n: bigint }[]>`
      WITH first_arrival AS (
        SELECT user_id, MIN(arrived_at) AS at
          FROM presence_sessions
         WHERE event_id = ${eventId}::uuid AND kind = 'attendee'
      GROUP BY user_id
      )
      SELECT to_timestamp(floor(extract(epoch FROM at) / 600) * 600) AS bucket, count(*) AS n
        FROM first_arrival
       WHERE at >= ${new Date(event.start_time.getTime() - 30 * 60 * 1000)} AND at < ${event.end_time}
    GROUP BY 1
    ORDER BY 1
    `,
    db.$queryRaw<{ came: bigint; first_timers: bigint }[]>`
      WITH ${attendanceCte(orgId)},
      firsts AS (SELECT user_id, MIN(start_time) AS first_at FROM att GROUP BY user_id)
      SELECT count(*) AS came, count(*) FILTER (WHERE a.start_time = f.first_at) AS first_timers
        FROM att a JOIN firsts f USING (user_id)
       WHERE a.event_id = ${eventId}::uuid
    `,
    // App views only: signed-in, in the app, kept 180 days (lib/product-events.ts).
    // The organisation's own members are not its audience; a view counts
    // toward an RSVP only if it came before it.
    db.$queryRaw<{ viewers: bigint; converted: bigint }[]>`
      WITH members AS (SELECT user_id FROM organisation_members WHERE org_id = ${orgId}::uuid),
      views AS (
        SELECT pe.user_id, MIN(pe.occurred_at) AS first_view
          FROM product_events pe
         WHERE pe.entity_id = ${eventId}::uuid AND pe.name = 'event_viewed' AND pe.user_id IS NOT NULL
           AND pe.user_id NOT IN (SELECT user_id FROM members)
      GROUP BY pe.user_id
      )
      SELECT (SELECT count(*) FROM views) AS viewers,
             (SELECT count(*) FROM views v JOIN event_rsvps r ON r.user_id = v.user_id AND r.event_id = ${eventId}::uuid
               WHERE r.status = ANY(${COMMITTED}::rsvp_status[]) AND v.first_view <= r.created_at) AS converted
    `,
  ])

  const s = stay[0]
  const stayPeople = s ? Number(s.people) : 0
  const came = Number(firsts[0]?.came ?? 0)
  const firstTimers = Number(firsts[0]?.first_timers ?? 0)
  const viewers = Number(funnel[0]?.viewers ?? 0)
  const converted = heldPart(Number(funnel[0]?.converted ?? 0), viewers)

  return {
    eventId,
    people: held(came),
    stay:
      s && stayPeople >= MIN_CELL
        ? {
            p50Min: Math.round(Number(s.p50) / 60),
            quartiles: stayPeople >= QUARTILE_FLOOR ? { p25Min: Math.round(Number(s.p25) / 60), p75Min: Math.round(Number(s.p75) / 60) } : null,
            leftEarlyPct: pct(heldPart(Number(s.left_early), stayPeople), stayPeople),
            softPct: pct(heldPart(Number(s.soft), stayPeople), stayPeople),
          }
        : null,
    arrivals: mergeArrivals(slots.map((a) => ({ at: a.bucket, n: Number(a.n) }))),
    firstTimers: heldPart(firstTimers, came),
    returning: heldPart(came - firstTimers, came),
    funnel: {
      viewers: held(viewers),
      viewersWhoRsvpd: converted,
      conversionPct: pct(converted, viewers),
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

export interface AnalyticsPageView {
  access: {
    org: boolean
    reason: AnalyticsAccess["reason"]
    freeUntil: string | null
    /** "renews" a running subscription's paid-up date, or "until" a grant's or a cancelled one's end. */
    date: { word: PlanDate["word"]; at: string } | null
    firstFreeEvent: { id: string; title: string; endedAt: string } | null
  }
  range: Range
  /** Null when the cross-event views are locked: the page draws the sample. */
  org: OrgAnalytics | null
  /** The organisation's ended events, newest first, and whether each is open. */
  events: { id: string; title: string; startsAt: string; open: boolean }[]
  selected: { id: string; title: string; startsAt: string; open: boolean; data: EventAnalytics | null } | null
}

/** Everything the Analytics page renders, for one organisation. Nothing paid is computed while locked. */
export async function analyticsPage(
  orgId: string,
  opts: { range: Range; eventId?: string },
  now: Date = new Date()
): Promise<AnalyticsPageView> {
  const access = await analyticsAccess(orgId, now)
  const [org, ended, firstFree, badge] = await Promise.all([
    orgAnalytics(access, opts.range, now),
    db.events.findMany({
      where: { organizer_org_id: orgId, deleted_at: null, end_time: { lt: now }, ...realEventsWhere },
      orderBy: { start_time: "desc" },
      take: COMPARISON_LIMIT,
      select: { id: true, title: true, start_time: true },
    }),
    access.firstFreeEventId
      ? db.events.findUnique({ where: { id: access.firstFreeEventId }, select: { id: true, title: true, end_time: true } })
      : null,
    planBadgeFor(orgId, now),
  ])

  const events = ended.map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.start_time.toISOString(),
    open: mayOpenEvent(access, e.id),
  }))
  const pick = events.find((e) => e.id === opts.eventId) ?? events[0] ?? null
  const data = pick?.open ? await eventAnalytics(access, pick.id) : null

  return {
    access: {
      org: access.org,
      reason: access.reason,
      freeUntil: access.freeUntil?.toISOString() ?? null,
      date: badge.date ? { word: badge.date.word, at: badge.date.at.toISOString() } : null,
      firstFreeEvent: firstFree ? { id: firstFree.id, title: firstFree.title, endedAt: firstFree.end_time.toISOString() } : null,
    },
    range: opts.range,
    org,
    events,
    selected: pick ? { ...pick, data } : null,
  }
}
