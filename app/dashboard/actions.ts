"use server"

import type { check_in_status, rsvp_status } from "@prisma/client"

import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
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
  VenueRow,
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
            check_ins: { where: { status: { in: ATTENDED } } },
          },
        },
      },
    }),
  ])

  // No-show rate over the last 30 days, and the 30 before it, so the delta says
  // whether it is getting better rather than just what it is.
  const [committedNow, attendedNow, committedPrior, attendedPrior, repeatRows] = await Promise.all([
    db.event_rsvps.count({
      where: { status: { in: COMMITTED }, event: { ...pastEvents, start_time: { gte: windowStart, lt: now } } },
    }),
    db.event_check_ins.count({
      where: { status: { in: ATTENDED }, event: { ...pastEvents, start_time: { gte: windowStart, lt: now } } },
    }),
    db.event_rsvps.count({
      where: { status: { in: COMMITTED }, event: { ...pastEvents, start_time: { gte: priorStart, lt: windowStart } } },
    }),
    db.event_check_ins.count({
      where: { status: { in: ATTENDED }, event: { ...pastEvents, start_time: { gte: priorStart, lt: windowStart } } },
    }),
    db.event_check_ins.groupBy({
      by: ["user_id"],
      where: { status: { in: ATTENDED }, event: eventScope(userId) },
      _count: { _all: true },
    }),
  ])

  // Turn-up capped at 100 (walk-ins check in without RSVPing), so no-show is
  // floored at 0 rather than going negative.
  const turnUpNow = pct(Math.min(attendedNow, committedNow), committedNow)
  const turnUpPrior = pct(Math.min(attendedPrior, committedPrior), committedPrior)
  const noShowNow = turnUpNow === null ? null : 100 - turnUpNow
  const noShowPrior = turnUpPrior === null ? null : 100 - turnUpPrior

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
    repeatAttendees: repeatRows.filter((r) => r._count._all > 1).length,
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
        event.start_time >= now || event._count.rsvps === 0
          ? null
          : Math.min(100, (event._count.check_ins / event._count.rsvps) * 100),
    })),
  }
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

async function buildAdminOverview(): Promise<AdminOverview> {
  const now = new Date()
  const weekStart = new Date(now.getTime() - 7 * DAY_MS)

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
    onboarded,
    rsvpUsers,
    checkedInUsers,
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
    db.event_check_ins.count({ where: { status: { in: ATTENDED }, event: eventScope() } }),
    db.user.count({ where: { role: { in: ["organizer", "venue_owner"] } } }),
    db.events
      .findMany({
        where: { ...eventScope(), status: "published" },
        select: { organizer_id: true },
        distinct: ["organizer_id"],
      })
      .then((rows) => rows.length),
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
    db.user.findMany({ select: { createdAt: true }, orderBy: { createdAt: "asc" } }),
    db.mobile_refresh_tokens.findMany({
      where: { created_at: { gte: new Date(now.getTime() - 8 * 7 * DAY_MS) } },
      select: { created_at: true, user_id: true },
    }),
    db.events.groupBy({
      by: ["organizer_id", "status"],
      where: eventScope(),
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
      signups: signupBuckets.filter((u) => u.createdAt <= bucketEnd).length,
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
      where: { ...eventScope(), status: "published" },
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

  const cityMap = new Map<string, CityRow>()
  for (const event of cityRows) {
    const city = event.city as string
    const existing = cityMap.get(city) ?? { city, events: 0, rsvps: 0, favourites: 0 }
    existing.events += 1
    existing.rsvps += event._count.rsvps
    existing.favourites += event._count.favorites
    cityMap.set(city, existing)
  }

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
    publishingHosts: { publishing: publishingHosts, total: hostAccounts },
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
    where: { ...eventScope(userId), venue_name: { not: null } },
    select: {
      id: true,
      title: true,
      start_time: true,
      venue_name: true,
      max_capacity: true,
      status: true,
      ratings: { select: { rating: true } },
      _count: { select: { rsvps: { where: { status: { in: COMMITTED } } } } },
    },
    orderBy: { start_time: "asc" },
  })

  const [committed, attended, upcoming14d] = await Promise.all([
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
  ])

  /* Venues are grouped by venue_name because there is no venues table. Two
     spellings of one room therefore read as two venues — flagged in the UI. */
  const byVenue = new Map<string, typeof events>()
  for (const event of events) {
    const key = event.venue_name as string
    byVenue.set(key, [...(byVenue.get(key) ?? []), event])
  }

  const venues: VenueRow[] = Array.from(byVenue.entries())
    .map(([name, venueEvents]) => {
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
    eventsNext14d: upcoming14d,
  }
}

/* -------------------------------------------------------------------------- */

export async function getDashboardOverview(role: DashboardRole, userId?: string) {
  try {
    if (role === "app_admin") return await buildAdminOverview()
    if (!userId) throw new Error("User ID is required for scoped dashboard reports")
    if (role === "venue_owner") return await buildVenueOverview(userId)
    return await buildOrganizerOverview(userId)
  } catch (error) {
    logger.error("Failed to build dashboard overview", {
      role,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/** Shared by the events screen for all three roles; scoped by the caller. */
export async function getEventRows(userId?: string): Promise<EventRow[]> {
  const now = new Date()
  const events = await db.events.findMany({
    where: eventScope(userId),
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
          check_ins: { where: { status: { in: ATTENDED } } },
        },
      },
    },
  })

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
      event.start_time >= now || event._count.rsvps === 0
        ? null
        : Math.min(100, (event._count.check_ins / event._count.rsvps) * 100),
  }))
}
