"use server"

import type { rsvp_status } from "@prisma/client"

import type { user_role } from "@prisma/client"

import { getAuth } from "@/lib/auth"
import { visibleEventsWhere } from "@/lib/event-visibility"
import { buildPacing, pacingWindowDays } from "@/lib/pacing"
import { attentionQueues } from "@/lib/attention-queues-query"
import { refusalsByReason } from "@/lib/check-in-refusals"
import { getSponsorOverview } from "@/lib/sponsor-actions"
import { canAccessDashboard } from "@/lib/rbac"
import { db } from "@/lib/db"
import { ATTENDED } from "@/lib/counting"
import { loopClosure } from "@/lib/loop-closure"
import { activeSince } from "@/lib/product-events"
import { cityDemand } from "@/lib/demand"
import { cityKey } from "@/lib/address"
import { VENUE_INDEX_PAGE } from "@/lib/constants"
import { logger } from "@/lib/logger"
import { tileDelta } from "@/lib/metric-delta"
import { previousRange, rangeLabel, resolveRange, type DateRange } from "@/lib/date-range"
import { normaliseVenueName } from "@/lib/venue-name"
import { repeatAttendees, turnUpPct, noShowPct } from "@/lib/counting"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import type {
  AdminOverview,
  CityRow,
  DashboardRole,
  NextEvent,
  OrganizerOverview,
  OrganiserSupplyRow,
  PacingPoint,
  RatingCounts,
  VenueOverview,
  VenueRecordRow,
  VenueRow,
  SponsorOverview,
} from "@/lib/dashboard-types"

const DAY_MS = 24 * 60 * 60 * 1000
// One definition of "they turned up", shared with lib/loop-closure.ts and the
// turn-up numbers. A local copy is how two screens end up disagreeing.
/** going and maybe are intent; not_going is a decline and never counts. */
const COMMITTED: rsvp_status[] = ["going", "maybe"]
/** Trailing window for venue utilisation and per-venue rates. */
const WINDOW_WEEKS = 8

function eventScope(userId?: string) {
  return { deleted_at: null, ...(userId ? { organizer_id: userId } : {}) }
}

/**
 * Supply a *host* published — curated rows excluded, all of them.
 *
 * Host liquidity answers "are real organisers publishing?", and the whole
 * premise of curation is that they are not yet and we are filling the gap
 * ourselves. Curated events carry `organizer_id = <the admin who curated
 * them>`, because that column records who *created* the row — so every
 * organiser-keyed supply query counted a founder as a host. Three curated
 * events read as `PUBLISHING HOSTS 2 of 3`. Curate enough and the number
 * reports a healthy host base made entirely of us, which is the opposite of
 * what it exists to say.
 *
 * **Claimed curated events are excluded too, and that is deliberate.** A claim
 * writes `organizer_org_id` and leaves `organizer_id` pointing at the admin
 * (CLAUDE.md: it is the audit column, never rewritten). So for a claimed row
 * the organiser-keyed table would still attribute it to a founder. The table
 * is keyed on the wrong column to represent any curated row, so it excludes
 * the lot and reports them on their own line instead. That undercounts a
 * claimed event by one — the safe direction, since the failure it replaces
 * was inflation.
 *
 * `lib/event-host.ts` answers the same question for the mobile payload and
 * says the same thing: the curating admin is never the host.
 */
function hostSupply(userId?: string) {
  return { ...eventScope(userId), curated_at: null }
}

function pct(part: number, whole: number) {
  return whole === 0 ? null : (part / whole) * 100
}

function round1(value: number | null) {
  return value === null ? null : Math.round(value * 10) / 10
}

function emptyRatings(): RatingCounts {
  return [0, 0, 0, 0, 0]
}

function toRatingCounts(rows: Array<{ rating: number; _count: { _all: number } }>): RatingCounts {
  const counts = emptyRatings()
  for (const row of rows) {
    if (row.rating >= 1 && row.rating <= 5) counts[row.rating - 1] = row._count._all
  }
  return counts
}

/* -------------------------------------------------------------------------- */
/* Organiser                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Cumulative RSVP curve for one event, bucketed by days before it starts.
 *
 * Uses `event_rsvps.created_at` against `events.start_time`, so the x axis is
 * "days out" rather than a calendar date — which is the only way two events of
 * different sizes and dates can be compared to each other.
 */

async function buildOrganizerOverview(userId: string, role: user_role): Promise<OrganizerOverview> {
  /*
   * Organisation-shaped, not identity-shaped (CLAUDE.md, and H2 in the audit):
   * `organizer_id` records who created the row. A colleague at the same org
   * saw an empty overview, and a venue owner saw only the events they had
   * personally created in their own building -- usually none.
   */
  const scope = await visibleEventsWhere({ id: userId, role })
  const now = new Date()
  const windowStart = new Date(now.getTime() - 30 * DAY_MS)
  const priorStart = new Date(now.getTime() - 60 * DAY_MS)
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const pastEvents = { ...scope, start_time: { lt: now } }

  const [next, previous, ratingSpread, ratingAggregate, chatToday, eventRows] = await Promise.all([
    db.events.findFirst({
      where: { ...scope, status: "published", start_time: { gte: now } },
      orderBy: { start_time: "asc" },
      select: {
        id: true,
        title: true,
        start_time: true,
        city: true,
        venue_name: true,
        max_capacity: true,
        // Committed only, like the benchmark query below: `not_going` is never
        // read, and this is the one event most likely to have many rows.
        rsvps: { where: { status: { in: COMMITTED } }, select: { created_at: true, status: true } },
        _count: { select: { favorites: true } },
      },
    }),
    // The benchmark for the pacing note: the most recent event that has run.
    db.events.findFirst({
      where: { ...pastEvents, status: "published" },
      orderBy: { start_time: "desc" },
      select: {
        title: true,
        start_time: true,
        max_capacity: true,
        rsvps: { where: { status: { in: COMMITTED } }, select: { created_at: true } },
      },
    }),
    db.event_ratings.groupBy({
      by: ["rating"],
      where: { event: scope },
      _count: { _all: true },
    }),
    db.event_ratings.aggregate({
      where: { event: scope },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    db.chat_messages.count({
      where: {
        deleted_at: null,
        created_at: { gte: todayStart },
        chat_group: { event: scope },
      },
    }),
    db.events.findMany({
      where: scope,
      orderBy: { start_time: "desc" },
      take: 25,
      select: {
        id: true,
        title: true,
        start_time: true,
        city: true,
        venue_name: true,
        status: true,
        max_capacity: true,
        _count: {
          select: {
            rsvps: { where: { status: "going" } },
          },
        },
      },
    }),
  ])

  // Turn-up per event, in one grouped query rather than 25 `_count`s that
  // cannot say DISTINCT.
  const attendedPerEvent = await distinctAttendeeCounts(eventRows.map((e) => e.id))

  // No-show rate over the last 30 days, and the 30 before it, so the delta says
  // whether it is getting better rather than just what it is.
  const [committedNow, attendedNow, committedPrior, attendedPrior, repeatRows] = await Promise.all([
    db.event_rsvps.count({
      where: { status: { in: COMMITTED }, event: { ...pastEvents, start_time: { gte: windowStart, lt: now } } },
    }),
    /*
     * Grouped by user, not counted. `event_check_ins` holds one row per person
     * per day, so a three-day conference contributed three attendances against
     * one RSVP — turn-up clamped to exactly 100% and no-show floored at 0%,
     * which is the number this whole block exists to report.
     */
    db.event_check_ins.groupBy({
      by: ["user_id"],
      where: { status: { in: ATTENDED }, kind: "attendee", event: { ...pastEvents, start_time: { gte: windowStart, lt: now } } },
    }),
    db.event_rsvps.count({
      where: { status: { in: COMMITTED }, event: { ...pastEvents, start_time: { gte: priorStart, lt: windowStart } } },
    }),
    db.event_check_ins.groupBy({
      by: ["user_id"],
      where: { status: { in: ATTENDED }, kind: "attendee", event: { ...pastEvents, start_time: { gte: priorStart, lt: windowStart } } },
    }),
    /*
     * Rows, not a grouped row-count.
     *
     * This grouped by user and asked `_count._all > 1`, which counts *rows*.
     * `event_check_ins` holds one row per person per day, so somebody who
     * attended both days of one conference was two rows and read as a
     * returning attendee — on the tile titled "came back for a 2nd event".
     * `repeatAttendees` folds on distinct `event_id` instead.
     */
    db.event_check_ins.findMany({
      where: { status: { in: ATTENDED }, event: scope },
      select: { user_id: true, event_id: true, kind: true },
    }),
  ])

  /*
   * The clamp is gone. It was justified as "walk-ins check in without RSVPing",
   * but its real job was absorbing the row-counting inflation above — and in
   * doing so it hid the walk-ins it named. `noShowPct` floors at zero, because
   * more people than RSVPs is zero no-shows plus some extra, not a negative.
   */
  const noShowNow = noShowPct(attendedNow.length, committedNow)
  const noShowPrior = noShowPct(attendedPrior.length, committedPrior)

  let nextEvent: NextEvent | null = null
  let pacing: PacingPoint[] = []
  let pacingCapacity: number | null = null
  let benchmark: OrganizerOverview["benchmark"] = null

  if (next) {
    const going = next.rsvps.filter((r) => r.status === "going").length
    const maybe = next.rsvps.filter((r) => r.status === "maybe").length
    const committed = next.rsvps.filter((r) => COMMITTED.includes(r.status))
    const daysOut = Math.max(0, Math.ceil((next.start_time.getTime() - now.getTime()) / DAY_MS))
    const windowDays = pacingWindowDays(daysOut)

    pacing = buildPacing(committed, next.start_time, windowDays)
    pacingCapacity = next.max_capacity

    let pacingNote: string | null = null
    if (previous && previous.rsvps.length > 0) {
      // The whole curve is drawn under the live one; the note reads one point of it.
      const previousPacing = buildPacing(previous.rsvps, previous.start_time, windowDays)
      benchmark = { title: previous.title, points: previousPacing }
      const atThisPoint = previousPacing.find((p) => p.daysOut === daysOut)
      if (atThisPoint && atThisPoint.cumulative > 0) {
        const ratio = committed.length / atThisPoint.cumulative
        pacingNote =
          ratio >= 1.1
            ? "Pacing ahead of your last event at this point."
            : ratio <= 0.9
              ? "Pacing behind your last event at this point."
              : "Pacing in line with your last event at this point."
      }
    }

    nextEvent = {
      id: next.id,
      title: next.title,
      startAt: next.start_time.toISOString(),
      venue: next.venue_name ?? "Venue TBD",
      city: next.city ?? "",
      daysOut,
      going,
      maybe,
      favourites: next._count.favorites,
      capacity: next.max_capacity,
      fillPct:
        next.max_capacity && next.max_capacity > 0
          ? Math.min(100, (committed.length / next.max_capacity) * 100)
          : null,
      pacingNote,
    }
  }

  return {
    role: "organizer",
    nextEvent,
    pacing,
    pacingCapacity,
    benchmark,
    ratings: toRatingCounts(ratingSpread),
    noShowRatePct: round1(noShowNow),
    noShowDelta:
      noShowNow === null || noShowPrior === null ? null : Math.round(noShowNow - noShowPrior),
    repeatAttendees: repeatAttendees(repeatRows),
    averageRating: round1(ratingAggregate._avg.rating),
    ratingCount: ratingAggregate._count.rating,
    chatToday,
    events: eventRows.map((event) => ({
      id: event.id,
      name: event.title,
      startAt: event.start_time.toISOString(),
      city: event.city ?? "",
      venue: event.venue_name ?? "—",
      status: event.status,
      going: event._count.rsvps,
      fillPct:
        event.max_capacity && event.max_capacity > 0
          ? Math.min(100, (event._count.rsvps / event.max_capacity) * 100)
          : null,
      turnUpPct:
        event.start_time >= now
          ? null
          : turnUpPct(attendedPerEvent.get(event.id) ?? 0, event._count.rsvps),
    })),
  }
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

async function buildAdminOverview(range: DateRange): Promise<AdminOverview> {
  const now = new Date()
  const weekStart = new Date(now.getTime() - 7 * DAY_MS)

  /*
   * Deltas are this window against the one immediately before it, same length.
   *
   * The tiles carried no delta at all before — a bare count answers "how many"
   * and never "is that good", which is the only question anyone opens this
   * screen with. `percentDelta` returns null when the earlier window is empty,
   * which at 44 users is most of them; inventing "+500%" for 0 → 5 would put a
   * meaningless number in the most trusted place on the page.
   */
  const prior = previousRange(range)
  const inRange = { gte: range.from, lt: range.to }
  const inPrior = { gte: prior.from, lt: prior.to }

  const [
    attention,
    activeThisWeek,
    checkIns,
    refusals,
    upcomingEvents,
    hostAccounts,
    publishingHosts,
    curatedPublished,
    curatedUnclaimed,
    funnel,
    supplyRows,
    cityRows,
    demandRows,
    checkInsPrior,
  ] = await Promise.all([
    /*
     * All four queues, from the module the sidebar badges also read.
     *
     * This replaced four `moderation_flags` reads that produced a count, an
     * age, a high-confidence subset and a room count — a rich description of
     * ONE queue on a strip whose job is "is anything waiting", while three
     * other queues went uncounted. Depth on one queue was the wrong axis;
     * breadth across all of them is the question.
     */
    attentionQueues(),
    /*
     * Real app-opens where there are any, the old proxy where there are not.
     *
     * This was distinct refresh-token holders in seven days — a number whose
     * own tile called it a "session proxy" and which really answered *whose
     * token happened to be issued this week*. `product_events` records an
     * app-open per person per day, so the true figure is now available.
     *
     * The fallback exists only for the transition: the table starts empty, and
     * a tile reading zero over a live product is worse than a proxy that at
     * least moves. Which source produced the number is returned with it and
     * rendered on the tile, so the screen never shows one while implying the
     * other.
     */
    activeSince(weekStart).then(async (real) => {
      if (real.source === "app_opens") return real
      const rows = await db.mobile_refresh_tokens.findMany({
        where: { revoked_at: null, created_at: { gte: weekStart } },
        select: { user_id: true },
        distinct: ["user_id"],
      })
      return { count: rows.length, source: "proxy" as const }
    }) as Promise<{ count: number; source: "app_opens" | "proxy" }>,
    /*
     * Window-scoped, matching its own delta.
     *
     * The comment further down already states the design: `users` and
     * `publishedEvents` are cumulative totals compared against their value at
     * `range.from`, while `checkIns` "is naturally window-scoped, so it
     * compares this window's count against the previous window's".
     *
     * The delta did exactly that. This value did not — it had no date filter,
     * so the tile paired an ALL-TIME count with a period-over-period change.
     * Six months in, that reads as "48,000 check-ins, -12%", where the number
     * and the arrow describe different questions.
     */
    db.event_check_ins.count({
      where: { status: { in: ATTENDED }, event: eventScope(), created_at: inRange },
    }),
    /*
     * The other half of the same door.
     *
     * Arrivals alone cannot tell a quiet week from a week where the fence was
     * wrong, and `check_in_refusals` has been recording the difference with no
     * platform-wide reader since it was added — the per-event screen was the
     * only place it surfaced, which means you had to already suspect an event
     * to find out anything was wrong with it.
     */
    refusalsByReason(range),
    /*
     * Published and not yet over.
     *
     * Replaces an all-time count of published events, which only ever went up
     * and answered a question nobody has. What an admin wants from supply is
     * whether there is anything to send people to *next week*.
     */
    db.events.count({
      where: { ...eventScope(), status: "published", end_time: { gte: now } },
    }),
    db.user.count({ where: { role: { in: ["organizer", "venue_owner"] } } }),
    db.events
      .findMany({
        where: { ...hostSupply(), status: "published" },
        select: { organizer_id: true },
        distinct: ["organizer_id"],
      })
      .then((rows) => rows.length),
    db.events.count({
      where: { ...eventScope(), status: "published", curated_at: { not: null } },
    }),
    db.events.count({
      where: {
        ...eventScope(),
        status: "published",
        curated_at: { not: null },
        claimed_at: null,
      },
    }),
    /*
     * The whole loop in one pass — see lib/loop-closure.ts.
     *
     * Three counts became one because the funnel gained three stages, and seven
     * superset scans on a screen that already fires ~28 round trips is the
     * wrong direction. The nested-subset rule those three counts existed to
     * enforce moved with them: it is the reason a funnel can be drawn at all,
     * and it is stated where the query is.
     */
    loopClosure(),
    db.events.groupBy({
      by: ["organizer_id", "status"],
      where: hostSupply(),
      _count: { _all: true },
    }),
    db.events.findMany({
      where: { ...eventScope(), status: "published", city: { not: null } },
      select: {
        city: true,
        _count: { select: { rsvps: true, favorites: true } },
      },
    }),
    /*
     * Moved up from the tail, where it was costing two sequential round trips
     * for nothing.
     *
     * It ran after wave 2 (`organisers`/`lastEvents`), which really does depend
     * on `supplyRows`. `cityDemand` depends on neither — it reads `city_demand`
     * and `events` directly — so it sat behind a wave it has no relationship
     * with, purely because of where the `await` happened to be written.
     * Measured by a latency pass; the fix is moving two lines.
     */
    cityDemand(50),
    /*
     * Same: the previous window's arrivals need only `range`, which wave 1
     * already has. It was the LAST thing the function did, in a single-item
     * `Promise.all`, after waves 1, 2 and 3.
     */
    db.event_check_ins.count({
      where: { status: { in: ATTENDED }, event: eventScope(), created_at: inPrior },
    }),
  ])

  /*
   * The signups-vs-active chart is gone, and so are its three queries.
   *
   * It was CUMULATIVE, which K4.7 has had on the register since the first
   * audit: a cumulative series can only go up, so it cannot show the one thing
   * a growth chart is for. Staging plotted 42, 42, 45, 82, 95, 95, 95, 121 —
   * three flat weeks in the middle that the chart drew as a plateau at the
   * ceiling, indistinguishable from healthy.
   *
   * The honest version is a weekly (non-cumulative) signup series, and that is
   * a build rather than a deletion: it wants `product_events`, which now
   * exists. Recorded as the next metric rather than shipped half-done, because
   * a chart that flatters is worse than no chart.
   */

  const publishedByOrganiser = new Map<string, number>()
  const draftsByOrganiser = new Map<string, number>()
  for (const row of supplyRows) {
    const target = row.status === "published" ? publishedByOrganiser : draftsByOrganiser
    target.set(row.organizer_id, (target.get(row.organizer_id) ?? 0) + row._count._all)
  }

  const organiserIds = Array.from(
    new Set([...publishedByOrganiser.keys(), ...draftsByOrganiser.keys()])
  )
  const [organisers, lastEvents] = await Promise.all([
    db.user.findMany({
      where: { id: { in: organiserIds } },
      select: { id: true, name: true, email: true },
    }),
    db.events.groupBy({
      by: ["organizer_id"],
      where: { ...hostSupply(), status: "published" },
      _max: { start_time: true },
    }),
  ])

  const totalPublished = Array.from(publishedByOrganiser.values()).reduce((a, b) => a + b, 0)
  const supply: OrganiserSupplyRow[] = organisers
    .map((organiser) => ({
      id: organiser.id,
      name: organiser.name ?? organiser.email,
      published: publishedByOrganiser.get(organiser.id) ?? 0,
      drafts: draftsByOrganiser.get(organiser.id) ?? 0,
      sharePct:
        totalPublished === 0
          ? 0
          : Math.round(((publishedByOrganiser.get(organiser.id) ?? 0) / totalPublished) * 100),
      lastEventAt:
        lastEvents.find((e) => e.organizer_id === organiser.id)?._max.start_time?.toISOString() ??
        null,
    }))
    .sort((a, b) => b.published - a.published)

  /*
   * Cities, keyed the way the rest of the codebase keys them.
   *
   * This folded on the raw `city` string, so "Bengaluru" and "bengaluru" were
   * two rows in the table a founder reads to decide where to launch. `cityKey`
   * is what `city_demand` stores and what the events cache normalises on;
   * anything else here would guarantee the two sides never line up.
   */
  const cityMap = new Map<string, CityRow>()
  for (const event of cityRows) {
    const city = event.city as string
    const key = cityKey(city)
    const existing = cityMap.get(key) ?? {
      city, events: 0, rsvps: 0, favourites: 0, waiting: 0, launchReady: false,
    }
    existing.events += 1
    existing.rsvps += event._count.rsvps
    existing.favourites += event._count.favorites
    cityMap.set(key, existing)
  }

  /*
   * C12: the list could not render the signal it existed to collect.
   *
   * Built by iterating events, so a city with demand and ZERO events could not
   * appear at all -- which is exactly the city the number is for: somewhere
   * people are looking and nobody is supplying.
   */
  for (const row of demandRows) {
    const existing = cityMap.get(row.cityKey)
    if (existing) {
      existing.waiting = row.waiting
      existing.launchReady = row.launchReady
    } else {
      cityMap.set(row.cityKey, {
        city: row.city,
        events: 0,
        rsvps: 0,
        favourites: 0,
        waiting: row.waiting,
        launchReady: row.launchReady,
      })
    }
  }

  return {
    role: "app_admin",
    attention,
    // Server time, so the client renders the same ages the server did.
    generatedAt: now.toISOString(),
    activeThisWeek,
    checkIns,
    refusals,
    deltas: { checkIns: tileDelta({ current: checkIns, previous: checkInsPrior }) },
    rangeLabel: rangeLabel(range),
    publishingHosts: { publishing: publishingHosts, total: hostAccounts },
    upcomingEvents,
    curated: { published: curatedPublished, unclaimed: curatedUnclaimed },
    funnel,
    supply,
    cities: Array.from(cityMap.values()).sort((a, b) => b.events - a.events),
  }
}

/* -------------------------------------------------------------------------- */
/* Venue owner                                                                 */
/* -------------------------------------------------------------------------- */

/** Four slots per day, by start hour. */
function slotFor(date: Date) {
  const hour = date.getHours()
  if (hour < 12) return 0
  if (hour < 17) return 1
  if (hour < 22) return 2
  return 3
}

/** Monday-first, matching the heatmap's axis. */
function dayIndex(date: Date) {
  return (date.getDay() + 6) % 7
}

async function buildVenueOverview(userId: string, role: user_role): Promise<VenueOverview> {
  /*
   * Organisation-shaped, not identity-shaped (CLAUDE.md, and H2 in the audit):
   * `organizer_id` records who created the row. A colleague at the same org
   * saw an empty overview, and a venue owner saw only the events they had
   * personally created in their own building -- usually none.
   */
  const scope = await visibleEventsWhere({ id: userId, role })
  const now = new Date()
  const windowStart = new Date(now.getTime() - WINDOW_WEEKS * 7 * DAY_MS)

  const events = await db.events.findMany({
    // An event linked to a venue counts even if its free-text name is null —
    // the link is the stronger statement about where it happened.
    where: {
      AND: [scope, { OR: [{ venue_name: { not: null } }, { venue_id: { not: null } }] }],
    },
    select: {
      id: true,
      title: true,
      start_time: true,
      venue_name: true,
      venue_id: true,
      venue: { select: { name: true } },
      max_capacity: true,
      status: true,
      ratings: { select: { rating: true } },
      _count: { select: { rsvps: { where: { status: { in: COMMITTED } } } } },
    },
    orderBy: { start_time: "asc" },
  })

  /*
   * Turn-up rate is the one venue metric that can carry a delta. "Peak window"
   * is a label ("Fri eve") and "events next 14d" is forward-looking — there is
   * no previous version of the future. Forcing a percentage onto either would
   * be a number with nothing behind it.
   *
   * The comparison is the last 90 days against the 90 before, rather than the
   * all-time figure against itself: a venue open two years has an all-time rate
   * that barely moves, so the delta would read 0% while this quarter fell off a
   * cliff.
   */
  const RECENT_MS = 90 * DAY_MS
  const recentFrom = new Date(now.getTime() - RECENT_MS)
  const priorFrom = new Date(now.getTime() - 2 * RECENT_MS)

  const [committed, attended, upcoming14d, recentCommitted, recentAttended, priorCommitted, priorAttended] =
    await Promise.all([
      db.event_rsvps.count({
        where: {
          status: { in: COMMITTED },
          event: { ...scope, start_time: { lt: now } },
        },
      }),
      db.event_check_ins.count({
        where: {
          status: { in: ATTENDED },
          event: { ...scope, start_time: { lt: now } },
        },
      }),
      db.events.count({
        where: {
          ...scope,
          status: "published",
          start_time: { gte: now, lte: new Date(now.getTime() + 14 * DAY_MS) },
        },
      }),
      db.event_rsvps.count({
        where: {
          status: { in: COMMITTED },
          event: { ...scope, start_time: { gte: recentFrom, lt: now } },
        },
      }),
      db.event_check_ins.count({
        where: {
          status: { in: ATTENDED },
          event: { ...scope, start_time: { gte: recentFrom, lt: now } },
        },
      }),
      db.event_rsvps.count({
        where: {
          status: { in: COMMITTED },
          event: { ...scope, start_time: { gte: priorFrom, lt: recentFrom } },
        },
      }),
      db.event_check_ins.count({
        where: {
          status: { in: ATTENDED },
          event: { ...scope, start_time: { gte: priorFrom, lt: recentFrom } },
        },
      }),
    ])

  // Percentage points, not a percentage of a percentage: turn-up going 60% → 66%
  // is "+6 points", and calling it "+10%" invites reading it as 70%.
  const recentTurnUp = pct(Math.min(recentAttended, recentCommitted), recentCommitted)
  const priorTurnUp = pct(Math.min(priorAttended, priorCommitted), priorCommitted)
  const turnUpDelta =
    recentTurnUp === null || priorTurnUp === null ? null : round1(recentTurnUp - priorTurnUp)

  /*
   * Grouped by `venue_id` where an event has one, and by a normalised name
   * where it does not.
   *
   * This used to group on the raw `venue_name` string alone, because nothing
   * ever wrote to the venues table. Two spellings of one room therefore read as
   * two venues, and the owner's numbers were split accordingly.
   *
   * Pure id-only grouping was the tempting version, and it is wrong here: an
   * organisation whose events predate the link — or any environment where the
   * backfill has not run — would see its venues vanish rather than merge. The
   * id is preferred when present and the name is the fallback, so the screen
   * gets strictly more correct as links appear rather than emptying out.
   *
   * Normalising case and whitespace fixes "The Loft" vs "the loft" for the
   * unlinked remainder, which the raw-string version never could.
   */
  const byVenue = new Map<string, { label: string; events: typeof events }>()
  for (const event of events) {
    const displayName = event.venue?.name ?? event.venue_name ?? "Unnamed venue"
    const key = event.venue_id ?? `name:${normaliseVenueName(displayName)}`
    const bucket = byVenue.get(key)
    if (bucket) bucket.events.push(event)
    else byVenue.set(key, { label: displayName, events: [event] })
  }

  const venues: VenueRow[] = Array.from(byVenue.values())
    .map(({ label: name, events: venueEvents }) => {
      const inWindow = venueEvents.filter((e) => e.start_time >= windowStart && e.start_time < now)
      const ratings = emptyRatings()
      let ratingTotal = 0
      let ratingCount = 0
      for (const event of venueEvents) {
        for (const { rating } of event.ratings) {
          if (rating >= 1 && rating <= 5) ratings[rating - 1] += 1
          ratingTotal += rating
          ratingCount += 1
        }
      }
      const averageRating = ratingCount === 0 ? null : ratingTotal / ratingCount
      const next = venueEvents.find((e) => e.start_time >= now && e.status === "published")
      const nightsPerWeek = inWindow.length / WINDOW_WEEKS

      // Tone is about what needs attention, not a ranking: a low rating across
      // several organisers' events is a facilities problem worth surfacing.
      // Only a low rating is an alarm; a quiet room is a fact, not a fault.
      const tone: VenueRow["tone"] =
        averageRating !== null && averageRating < 3.5
          ? "destructive"
          : nightsPerWeek >= 2
            ? "success"
            : "neutral"

      return {
        name,
        eventsInWindow: inWindow.length,
        nightsPerWeek: Math.round(nightsPerWeek * 10) / 10,
        averageRating: round1(averageRating),
        ratings,
        nextBooking: next
          ? {
              id: next.id,
              name: next.title,
              startAt: next.start_time.toISOString(),
              going: next._count.rsvps,
            }
          : null,
        capacityProxy: venueEvents.reduce<number | null>(
          (max, e) => (e.max_capacity && (max === null || e.max_capacity > max) ? e.max_capacity : max),
          null
        ),
        tone,
        note:
          averageRating !== null && averageRating < 3.5
            ? "ratings skew low"
            : nightsPerWeek >= 2
              ? "busiest room"
              : nightsPerWeek < 0.5
                ? `quiet — ${inWindow.length} in ${WINDOW_WEEKS} weeks`
                : "steady",
      }
    })
    .sort((a, b) => b.nightsPerWeek - a.nightsPerWeek)

  const utilisation = Array.from({ length: 7 }, () => [0, 0, 0, 0])
  for (const event of events) {
    if (event.start_time < windowStart || event.start_time >= now) continue
    utilisation[dayIndex(event.start_time)][slotFor(event.start_time)] += 1
  }

  let peakWindow: string | null = null
  let peakCount = 0
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  const SLOT_NAMES = ["morning", "afternoon", "evening", "late"]
  utilisation.forEach((slots, di) =>
    slots.forEach((count, si) => {
      if (count > peakCount) {
        peakCount = count
        peakWindow = `${DAY_NAMES[di]} ${SLOT_NAMES[si]}`
      }
    })
  )

  return {
    role: "venue_owner",
    venues,
    utilisation,
    peakWindow,
    turnUpRatePct: round1(pct(Math.min(attended, committed), committed)),
    turnUpDelta,
    eventsNext14d: upcoming14d,
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Role and identity come from the session, never from the caller.
 *
 * These are `"use server"` exports, which means each one is a POST endpoint
 * that anyone reaching `/dashboard` can invoke directly with arguments of their
 * choosing -- the page component is not in the path. Taking `role` as a
 * parameter therefore let any organiser or venue owner pass `"app_admin"` and
 * receive the whole-platform report, including every other organiser's name and
 * email; taking `userId` let them read a competitor's pacing, drafts and
 * no-show rate. The page-level `role !== "app_admin"` redirects guard the view
 * and not the data, so they never applied here.
 */
async function dashboardActor(): Promise<{ role: DashboardRole; userId: string }> {
  const session = await getAuth()
  const role = session?.user?.role as DashboardRole | undefined
  if (!session?.user?.id || !role || !canAccessDashboard(role as user_role)) {
    throw new Error("Not authorised")
  }
  return { role, userId: session.user.id }
}


/**
 * The sponsor's landing page.
 *
 * Delegates to `getSponsorOverview`, which already assembles exactly this and
 * is already rendered by `/dashboard/placements`. Building a second set of
 * sponsor numbers here is how one question comes to have two answers — the
 * failure this codebase has an audit section about.
 *
 * Dates are serialised because this crosses to a client component, and the
 * other three overviews do the same.
 */
async function buildSponsorOverview(): Promise<SponsorOverview> {
  const o = await getSponsorOverview()
  return {
    role: "sponsor",
    brandName: o.brandName,
    next: o.next
      ? {
          eventTitle: o.next.eventTitle,
          startTime: o.next.startTime.toISOString(),
          ready: o.next.ready,
          blocker: o.next.blocker,
        }
      : null,
    liveNow: o.liveNow,
    awaitingYou: o.awaitingYou,
    reach30d: o.reach30d,
    reach30dSuppressed: o.reach30dSuppressed,
  }
}

export async function getDashboardOverview(range: DateRange = resolveRange({})) {
  const { role, userId } = await dashboardActor()
  try {
    if (role === "app_admin") return await buildAdminOverview(range)
    if (role === "venue_owner") return await buildVenueOverview(userId, role)
    /*
     * Sponsors used to fall through to the line below — an organiser overview
     * scoped to `organizer_id = <their own user id>`, which is never theirs. So
     * every sponsor's landing page read all zeros, permanently, and looked like
     * a quiet month rather than a screen asking the wrong question.
     */
    if (role === "sponsor") return await buildSponsorOverview()
    return await buildOrganizerOverview(userId, role)
  } catch (error) {
    logger.error("Failed to build dashboard overview", {
      role,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Every venue record, for the admin index.
 *
 * `dashboard-nav.ts` has described this screen since it was written — "every
 * venue record — who owns each, which are unclaimed" — and pointed at
 * `/dashboard/venue-owners`, which is a list of *user accounts*. So the one
 * role that can see every venue had no way to see any of them, the unclaimed
 * venue nobody had assigned was invisible to the person who would assign it,
 * and the venue detail page's own "← All venues" link went to a screen that
 * redirected admins away.
 *
 * Records, not utilisation. The owner's view answers "how is my building
 * doing"; this answers "what exists and who owns it", which is an operational
 * question with a different shape and a different sort order.
 */
/**
 * The admin venue index.
 *
 * ## Bounded, and the screen says so
 *
 * This was an unbounded `findMany` with two correlated counts per row, and the
 * screen rendered every row it returned with no pagination. On the local seed
 * that is **395 rows and a 15,812px document**; in production it is however
 * many venues exist, all of them, every time an admin opens the page. Nothing
 * on the screen offered a search box to avoid it.
 *
 * The cap is returned with the rows rather than applied silently — the same
 * *no silent caps* rule the exports follow. A truncated list that presents
 * itself as the whole list is how an operator concludes a venue is missing.
 *
 * The page size lives in `lib/constants.ts`, NOT beside the query. A
 * `"use server"` module may only export async functions, and an `export const`
 * here is a build error that neither `tsc` nor the unit suite sees — only
 * `next build` does. That has now happened twice; the guard below it has been
 * widened so there is not a third.
 */
export async function getVenueRecords(
  q = ""
): Promise<{ venues: VenueRecordRow[]; total: number }> {
  const session = await getAuth()
  if (session?.user?.role !== "app_admin") throw new Error("Forbidden")

  // Name or city. Server-side because the list is a page: a search over the
  // 200 rows the client holds cannot find the 201st, and used to say nothing.
  const where = {
    deleted_at: null,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { city: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  }
  const [venues, total] = await Promise.all([
    db.venues.findMany({
      where,
      select: {
        id: true,
        name: true,
        city: true,
        status: true,
        owner_org: { select: { display_name: true } },
        _count: {
          select: {
            events: { where: { deleted_at: null } },
            claims: { where: { status: "pending" } },
          },
        },
      },
      /*
       * Unclaimed first, then by name.
       *
       * Alphabetical put "Aashirwad Bar" at the top of 395 rows and the venues
       * with a pending claim wherever their name fell. Unclaimed is the queue —
       * this file's own component docstring says so — and a queue sorted by
       * name is not a queue.
       */
      orderBy: [{ owner_org_id: { sort: "asc", nulls: "first" } }, { name: "asc" }],
      take: VENUE_INDEX_PAGE,
    }),
    db.venues.count({ where }),
  ])

  return {
    venues: venues.map((venue) => ({
      id: venue.id,
      name: venue.name,
      city: venue.city,
      owner: venue.owner_org?.display_name ?? null,
      ownership: venue.owner_org ? ("claimed" as const) : ("unclaimed" as const),
      events: venue._count.events,
      pendingClaims: venue._count.claims,
      status: venue.status,
    })),
    total,
  }
}
