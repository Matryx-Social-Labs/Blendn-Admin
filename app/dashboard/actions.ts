"use server"

import type { check_in_status, rsvp_status } from "@prisma/client"

import type { user_role } from "@prisma/client"

import { getAuth } from "@/lib/auth"
import { getSponsorOverview } from "@/lib/sponsor-actions"
import { canAccessDashboard } from "@/lib/rbac"
import { db } from "@/lib/db"
import { cityDemand } from "@/lib/demand"
import { cityKey } from "@/lib/address"
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
  EventRow,
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
const ATTENDED: check_in_status[] = ["checked_in", "checked_out"]
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
function buildPacing(
  rsvps: Array<{ created_at: Date }>,
  startTime: Date,
  windowDays: number
): PacingPoint[] {
  const daysBefore = rsvps
    .map((r) => Math.max(0, Math.ceil((startTime.getTime() - r.created_at.getTime()) / DAY_MS)))
    .sort((a, b) => b - a)

  const points: PacingPoint[] = []
  for (let d = windowDays; d >= 0; d--) {
    points.push({ daysOut: d, cumulative: daysBefore.filter((x) => x >= d).length })
  }
  return points
}

async function buildOrganizerOverview(userId: string): Promise<OrganizerOverview> {
  const now = new Date()
  const windowStart = new Date(now.getTime() - 30 * DAY_MS)
  const priorStart = new Date(now.getTime() - 60 * DAY_MS)
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const pastEvents = { ...eventScope(userId), start_time: { lt: now } }

  const [next, previous, ratingSpread, ratingAggregate, chatToday, eventRows] = await Promise.all([
    db.events.findFirst({
      where: { ...eventScope(userId), status: "published", start_time: { gte: now } },
      orderBy: { start_time: "asc" },
      select: {
        id: true,
        title: true,
        start_time: true,
        city: true,
        venue_name: true,
        max_capacity: true,
        rsvps: { select: { created_at: true, status: true } },
        _count: { select: { favorites: true } },
      },
    }),
    // The benchmark for the pacing note: the most recent event that has run.
    db.events.findFirst({
      where: { ...pastEvents, status: "published" },
      orderBy: { start_time: "desc" },
      select: {
        start_time: true,
        max_capacity: true,
        rsvps: { where: { status: { in: COMMITTED } }, select: { created_at: true } },
      },
    }),
    db.event_ratings.groupBy({
      by: ["rating"],
      where: { event: eventScope(userId) },
      _count: { _all: true },
    }),
    db.event_ratings.aggregate({
      where: { event: eventScope(userId) },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    db.chat_messages.count({
      where: {
        deleted_at: null,
        created_at: { gte: todayStart },
        chat_group: { event: eventScope(userId) },
      },
    }),
    db.events.findMany({
      where: eventScope(userId),
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
      where: { status: { in: ATTENDED }, event: eventScope(userId) },
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

  if (next) {
    const going = next.rsvps.filter((r) => r.status === "going").length
    const maybe = next.rsvps.filter((r) => r.status === "maybe").length
    const committed = next.rsvps.filter((r) => COMMITTED.includes(r.status))
    const daysOut = Math.max(0, Math.ceil((next.start_time.getTime() - now.getTime()) / DAY_MS))
    const windowDays = Math.max(7, Math.min(60, daysOut + 14))

    pacing = buildPacing(committed, next.start_time, windowDays)
    pacingCapacity = next.max_capacity

    let pacingNote: string | null = null
    if (previous && previous.rsvps.length > 0) {
      const benchmark = buildPacing(previous.rsvps, previous.start_time, windowDays).find(
        (p) => p.daysOut === daysOut
      )
      if (benchmark && benchmark.cumulative > 0) {
        const ratio = committed.length / benchmark.cumulative
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
    pendingFlags,
    oldestFlag,
    highConfidence,
    flagRooms,
    users,
    activeThisWeek,
    publishedEvents,
    checkIns,
    hostAccounts,
    publishingHosts,
    curatedPublished,
    curatedUnclaimed,
    onboarded,
    rsvpUsers,
    checkedInUsers,
    signupsBeforeWindow,
    signupBuckets,
    activeBuckets,
    supplyRows,
    cityRows,
  ] = await Promise.all([
    db.moderation_flags.count({ where: { status: "pending" } }),
    db.moderation_flags.findFirst({
      where: { status: "pending" },
      orderBy: { created_at: "asc" },
      select: { created_at: true },
    }),
    // 0.9 is the pipeline's own "act without a human" threshold; above it a
    // flag is very likely real, which is what makes it the queue's priority.
    db.moderation_flags.count({ where: { status: "pending", confidence: { gte: 0.9 } } }),
    db.moderation_flags.findMany({
      where: { status: "pending" },
      select: { chat_group_id: true },
      distinct: ["chat_group_id"],
    }),
    db.user.count(),
    db.mobile_refresh_tokens
      .findMany({
        where: { revoked_at: null, created_at: { gte: weekStart } },
        select: { user_id: true },
        distinct: ["user_id"],
      })
      .then((rows) => rows.length),
    db.events.count({ where: { ...eventScope(), status: "published" } }),
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
     * Funnel stages must be nested subsets, or the shape lies.
     *
     * The first version counted four independent populations — every onboarded
     * profile, every user with an RSVP, every user with a check-in — and drew
     * them as a funnel. Staging had 7 onboarded and 10 RSVP'd, because a user
     * can RSVP without ever completing onboarding, so stage 3 was wider than
     * stage 2 and the chart showed a funnel widening downward.
     *
     * Each stage now filters on the one above it.
     */
    db.user.count({ where: { profile: { onboarded: true } } }),
    db.user.count({
      where: { profile: { onboarded: true }, event_rsvps: { some: {} } },
    }),
    db.user.count({
      where: {
        profile: { onboarded: true },
        event_rsvps: { some: {} },
        event_check_ins: { some: { status: { in: ATTENDED } } },
      },
    }),
    /*
     * A baseline count, not every user row.
     *
     * The `signups` line is CUMULATIVE — each of the eight points is "every
     * user created up to this bucket" — so the old query loaded the entire
     * `user` table to compute it, ordered, for eight numbers. It is invisible
     * under ~20k users and then it is not, and the sibling
     * `mobile_refresh_tokens` query on the next line already shows the bounded
     * pattern.
     *
     * Split in two: one count for everything before the window, and only the
     * rows inside it. Cumulative semantics are preserved exactly —
     * `baseline + (rows up to bucketEnd)` — while transfer is bounded by
     * signups in the last eight weeks rather than by all history.
     */
    db.user.count({ where: { createdAt: { lt: new Date(now.getTime() - 8 * 7 * DAY_MS) } } }),
    db.user.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - 8 * 7 * DAY_MS) } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    db.mobile_refresh_tokens.findMany({
      where: { created_at: { gte: new Date(now.getTime() - 8 * 7 * DAY_MS) } },
      select: { created_at: true, user_id: true },
    }),
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
  ])

  /* Weekly growth: cumulative signups against distinct users with a session
     that week. Plotted together deliberately — the gap between the two lines
     is the vanity, and a signups line alone hides it entirely. */
  const growth: AdminOverview["growth"] = []
  for (let week = 7; week >= 0; week--) {
    const bucketEnd = new Date(now.getTime() - week * 7 * DAY_MS)
    const bucketStart = new Date(bucketEnd.getTime() - 7 * DAY_MS)
    growth.push({
      label: week === 0 ? "now" : `−${week}w`,
      // Cumulative: everything before the window, plus what landed inside it
      // up to this bucket. Identical to the old all-rows filter.
      signups:
        signupsBeforeWindow + signupBuckets.filter((u) => u.createdAt <= bucketEnd).length,
      active: new Set(
        activeBuckets
          .filter((t) => t.created_at > bucketStart && t.created_at <= bucketEnd)
          .map((t) => t.user_id)
      ).size,
    })
  }

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
  for (const row of await cityDemand(50)) {
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

  /*
   * Two shapes of comparison, because the metrics are two shapes.
   *
   * `users` and `publishedEvents` are cumulative totals, so the honest question
   * is "how much did the total grow across this window" — the baseline is the
   * total as it stood at `range.from`. `checkIns` is naturally window-scoped, so
   * it compares this window's count against the previous window's.
   *
   * Comparing a cumulative total against a windowed count would be the classic
   * version of this bug: an all-time figure divided by 30 days of activity,
   * rendering a delta in the thousands of percent.
   */
  const [usersAtStart, eventsAtStart, checkInsNow, checkInsPrior] = await Promise.all([
    db.user.count({ where: { createdAt: { lt: range.from } } }),
    db.events.count({
      where: { ...eventScope(), status: "published", created_at: { lt: range.from } },
    }),
    db.event_check_ins.count({
      where: { status: { in: ATTENDED }, event: eventScope(), created_at: inRange },
    }),
    db.event_check_ins.count({
      where: { status: { in: ATTENDED }, event: eventScope(), created_at: inPrior },
    }),
  ])

  return {
    role: "app_admin",
    attention: {
      pending: pendingFlags,
      oldestHours: oldestFlag
        ? Math.floor((now.getTime() - oldestFlag.created_at.getTime()) / (60 * 60 * 1000))
        : null,
      highConfidence,
      affectedRooms: flagRooms.length,
    },
    users,
    activeThisWeek,
    publishedEvents,
    checkIns,
    deltas: {
      users: tileDelta({ current: users, previous: usersAtStart }),
      publishedEvents: tileDelta({ current: publishedEvents, previous: eventsAtStart }),
      checkIns: tileDelta({ current: checkInsNow, previous: checkInsPrior }),
    },
    rangeLabel: rangeLabel(range),
    publishingHosts: { publishing: publishingHosts, total: hostAccounts },
    curated: { published: curatedPublished, unclaimed: curatedUnclaimed },
    growth,
    funnel: [
      { label: "signed up", value: users },
      { label: "onboarded", value: onboarded },
      { label: "RSVP'd", value: rsvpUsers },
      { label: "checked in", value: checkedInUsers },
    ],
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

async function buildVenueOverview(userId: string): Promise<VenueOverview> {
  const now = new Date()
  const windowStart = new Date(now.getTime() - WINDOW_WEEKS * 7 * DAY_MS)

  const events = await db.events.findMany({
    // An event linked to a venue counts even if its free-text name is null —
    // the link is the stronger statement about where it happened.
    where: {
      ...eventScope(userId),
      OR: [{ venue_name: { not: null } }, { venue_id: { not: null } }],
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
          event: { ...eventScope(userId), start_time: { lt: now } },
        },
      }),
      db.event_check_ins.count({
        where: {
          status: { in: ATTENDED },
          event: { ...eventScope(userId), start_time: { lt: now } },
        },
      }),
      db.events.count({
        where: {
          ...eventScope(userId),
          status: "published",
          start_time: { gte: now, lte: new Date(now.getTime() + 14 * DAY_MS) },
        },
      }),
      db.event_rsvps.count({
        where: {
          status: { in: COMMITTED },
          event: { ...eventScope(userId), start_time: { gte: recentFrom, lt: now } },
        },
      }),
      db.event_check_ins.count({
        where: {
          status: { in: ATTENDED },
          event: { ...eventScope(userId), start_time: { gte: recentFrom, lt: now } },
        },
      }),
      db.event_rsvps.count({
        where: {
          status: { in: COMMITTED },
          event: { ...eventScope(userId), start_time: { gte: priorFrom, lt: recentFrom } },
        },
      }),
      db.event_check_ins.count({
        where: {
          status: { in: ATTENDED },
          event: { ...eventScope(userId), start_time: { gte: priorFrom, lt: recentFrom } },
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
      const tone: VenueRow["tone"] =
        averageRating !== null && averageRating < 3.5
          ? "destructive"
          : nightsPerWeek >= 2
            ? "success"
            : nightsPerWeek < 0.5
              ? "destructive"
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
            ? "ratings low"
            : nightsPerWeek >= 2
              ? "performing"
              : nightsPerWeek < 0.5
                ? "underused"
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
    if (role === "venue_owner") return await buildVenueOverview(userId)
    /*
     * Sponsors used to fall through to the line below — an organiser overview
     * scoped to `organizer_id = <their own user id>`, which is never theirs. So
     * every sponsor's landing page read all zeros, permanently, and looked like
     * a quiet month rather than a screen asking the wrong question.
     */
    if (role === "sponsor") return await buildSponsorOverview()
    return await buildOrganizerOverview(userId)
  } catch (error) {
    logger.error("Failed to build dashboard overview", {
      role,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Shared by the events screen for all three roles, scoped by the session.
 *
 * It used to take an optional `userId` and scope to it -- so omitting the
 * argument widened the query to every event on the platform, drafts included.
 * "Scoped by the caller" is not a scope when the caller is whoever sent the
 * POST.
 */
export async function getEventRows(): Promise<EventRow[]> {
  const { role, userId } = await dashboardActor()
  const now = new Date()
  const events = await db.events.findMany({
    where: eventScope(role === "app_admin" ? undefined : userId),
    orderBy: { start_time: "desc" },
    take: 100,
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
  })

  const attendedPerEvent = await distinctAttendeeCounts(events.map((e) => e.id))

  return events.map((event) => ({
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
  }))
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
export async function getVenueRecords(): Promise<VenueRecordRow[]> {
  const session = await getAuth()
  if (session?.user?.role !== "app_admin") throw new Error("Forbidden")

  const venues = await db.venues.findMany({
    where: { deleted_at: null },
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
    orderBy: { name: "asc" },
  })

  return venues.map((venue) => ({
    id: venue.id,
    name: venue.name,
    city: venue.city,
    owner: venue.owner_org?.display_name ?? null,
    events: venue._count.events,
    pendingClaims: venue._count.claims,
    status: venue.status,
  }))
}
