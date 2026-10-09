import { Prisma, type rsvp_status } from "@prisma/client"

import { analyticsAccess, mayOpenEvent, type AnalyticsAccess } from "./analytics-access"
import { ATTENDED } from "./counting"
import { db } from "./db"
import { discloseFigure, discloseRating, MIN_CELL } from "./disclosure"
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
 * ## Every figure is floored
 *
 * Counts of people use the minimum cell (`MIN_CELL`, 5). A count that is a
 * subset of a known group — first-timers of the people who came, the cohort
 * that came back — goes through `discloseFigure`, so a cell that is everyone or
 * everyone-but-one is held back too. A percentage is shown only when its
 * numerator was. Held back is `null`, and the screen says "held back".
 */

const DAY_MS = 24 * 60 * 60 * 1000
const COMMITTED: rsvp_status[] = ["going", "maybe"]
/** Past events in the comparison: the most recent this many. */
const COMPARISON_LIMIT = 50
/** The pacing benchmark: the median of this many of your last events. */
export const PACING_MEDIAN_OF = 5
/** Leaving more than this before the end counts as leaving early. */
const LEFT_EARLY_MS = 30 * 60 * 1000

export type Range = "30d" | "90d" | "all"
export const RANGES: Range[] = ["30d", "90d", "all"]

export function parseRange(value: string | undefined): Range {
  return value === "30d" || value === "all" ? value : "90d"
}

function rangeStart(range: Range, now: Date): Date {
  if (range === "all") return new Date(0)
  return new Date(now.getTime() - (range === "30d" ? 30 : 90) * DAY_MS)
}

/** A plain count of people, at the minimum cell. */
export const held = (n: number): number | null => (n >= MIN_CELL ? n : null)

/** A subset of a known group of people, through every disclosure check. */
export const heldPart = (part: number, whole: number): number | null =>
  whole < MIN_CELL ? null : discloseFigure({ count: part, contributors: part, population: whole }).value

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
       AND ci.status::text IN (${Prisma.join(ATTENDED)})
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
  /** "2026-08": the month of each person's first event here. */
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
  /** The hero: of the people whose first event here was in range, the share back within 90 days. */
  backWithin90: { pct: number | null; cohort: number | null }
  comparison: ComparisonRow[]
  cohorts: CohortRow[]
  pacing: PacingVsMedian | null
}

export async function orgAnalytics(
  access: AnalyticsAccess,
  range: Range,
  now: Date = new Date()
): Promise<OrgAnalytics | null> {
  if (!access.org) return null
  const orgId = access.orgId
  const from = rangeStart(range, now)

  const [comparison, cohortRows, pacing] = await Promise.all([
    comparisonRows(orgId, from, now),
    db.$queryRaw<
      { month: string; people: bigint; e30: bigint; b30: bigint; e60: bigint; b60: bigint; e90: bigint; b90: bigint }[]
    >`
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
       WHERE first_at >= ${from} AND first_at < ${now}
    GROUP BY 1
    ORDER BY 1 DESC
    `,
    pacingVsMedian(orgId, now),
  ])

  const window = (people: number, eligible: number, back: number): number | null | "open" => {
    if (eligible < people) return "open"
    return pct(heldPart(back, eligible), eligible)
  }
  const cohorts: CohortRow[] = cohortRows.map((r) => {
    const people = Number(r.people)
    return {
      month: r.month,
      people: held(people),
      back: {
        d30: held(people) === null ? null : window(people, Number(r.e30), Number(r.b30)),
        d60: held(people) === null ? null : window(people, Number(r.e60), Number(r.b60)),
        d90: held(people) === null ? null : window(people, Number(r.e90), Number(r.b90)),
      },
    }
  })

  // The hero pools every cohort whose 90-day window has closed.
  const e90 = cohortRows.reduce((n, r) => n + Number(r.e90), 0)
  const b90 = cohortRows.reduce((n, r) => n + Number(r.b90), 0)

  return {
    range,
    backWithin90: { pct: pct(heldPart(b90, e90), e90), cohort: held(e90) },
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

export interface EventAnalytics {
  eventId: string
  people: number | null
  stay: {
    p25Min: number
    p50Min: number
    p75Min: number
    leftEarlyPct: number | null
    softPct: number | null
  } | null
  /** First arrivals per 10 minutes from 30 minutes before the start; null bars are under the floor. */
  arrivals: { at: string; people: number | null }[]
  firstTimers: number | null
  returning: number | null
  funnel: { viewers: number | null; rsvps: number; viewersWhoRsvpd: number | null; conversionPct: number | null }
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

  const [stay, arrivals, firsts, viewers, rsvpd, viewedAndRsvpd] = await Promise.all([
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
    db.product_events.findMany({
      where: { name: "event_viewed", entity_id: eventId, user_id: { not: null } },
      distinct: ["user_id"],
      select: { user_id: true },
    }),
    db.event_rsvps.count({ where: { event_id: eventId, status: { in: COMMITTED } } }),
    db.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT r.user_id) AS n
        FROM event_rsvps r
        JOIN product_events pe ON pe.user_id = r.user_id AND pe.entity_id = r.event_id AND pe.name = 'event_viewed'
       WHERE r.event_id = ${eventId}::uuid AND r.status::text IN ('going', 'maybe')
    `,
  ])

  const s = stay[0]
  const stayPeople = s ? Number(s.people) : 0
  const came = Number(firsts[0]?.came ?? 0)
  const firstTimers = Number(firsts[0]?.first_timers ?? 0)
  const viewerCount = viewers.length
  const converted = Number(viewedAndRsvpd[0]?.n ?? 0)
  const convertedHeld = heldPart(converted, viewerCount)

  return {
    eventId,
    people: held(came),
    stay:
      s && stayPeople >= MIN_CELL
        ? {
            p25Min: Math.round(Number(s.p25) / 60),
            p50Min: Math.round(Number(s.p50) / 60),
            p75Min: Math.round(Number(s.p75) / 60),
            leftEarlyPct: pct(heldPart(Number(s.left_early), stayPeople), stayPeople),
            softPct: pct(heldPart(Number(s.soft), stayPeople), stayPeople),
          }
        : null,
    arrivals: arrivals.map((a) => ({ at: a.bucket.toISOString(), people: held(Number(a.n)) })),
    firstTimers: heldPart(firstTimers, came),
    returning: heldPart(came - firstTimers, came),
    funnel: {
      viewers: held(viewerCount),
      rsvps: rsvpd,
      viewersWhoRsvpd: convertedHeld,
      conversionPct: pct(convertedHeld, viewerCount),
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
    paidUntil: string | null
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
  const [org, ended, firstFree] = await Promise.all([
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
      paidUntil: access.paidUntil?.toISOString() ?? null,
      firstFreeEvent: firstFree ? { id: firstFree.id, title: firstFree.title, endedAt: firstFree.end_time.toISOString() } : null,
    },
    range: opts.range,
    org,
    events,
    selected: pick ? { ...pick, data } : null,
  }
}
