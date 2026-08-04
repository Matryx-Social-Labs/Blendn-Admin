"use server"

import { logger } from "@/lib/logger"
import type { check_in_status } from "@prisma/client"

import { db } from "@/lib/db"
import type {
  DashboardExportBundle,
  DashboardMetric,
  DashboardPerformanceRow,
  DashboardReport,
  DashboardRole,
  DashboardSpotlightCard,
  DashboardTrendPoint,
} from "@/lib/dashboard-types"

const DAY_IN_MS = 24 * 60 * 60 * 1000
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const ATTENDED_STATUSES: check_in_status[] = ["checked_in", "checked_out"]

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function addMonths(date: Date, months: number) {
  const next = new Date(date)
  next.setMonth(next.getMonth() + months)
  return next
}

function startOfDay(date: Date) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function startOfMonth(date: Date) {
  const next = new Date(date)
  next.setDate(1)
  next.setHours(0, 0, 0, 0)
  return next
}

function monthLabel(date: Date) {
  return `${MONTH_NAMES[date.getMonth()]} ${String(date.getFullYear()).slice(-2)}`
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value)
}

function wholeNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
}

function oneDecimal(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value)
}

function percentChange(current: number, previous: number) {
  if (previous === 0) {
    return current === 0 ? 0 : 100
  }

  return ((current - previous) / previous) * 100
}

function changeMeta(current: number, previous: number) {
  const delta = percentChange(current, previous)
  const trend: DashboardMetric["trend"] =
    current === previous ? "flat" : current > previous ? "up" : "down"

  if (trend === "flat") {
    return { trend, delta: "Flat vs prior 30d" as const }
  }

  const prefix = delta > 0 ? "+" : ""
  return {
    trend,
    delta: `${prefix}${oneDecimal(delta)}% vs prior 30d`,
  }
}

function toMetric(label: string, value: string, current: number, previous: number, detail: string): DashboardMetric {
  const meta = changeMeta(current, previous)
  return {
    label,
    value,
    delta: meta.delta,
    trend: meta.trend,
    detail,
  }
}

function eventScope(userId?: string) {
  return {
    deleted_at: null,
    ...(userId ? { organizer_id: userId } : {}),
  }
}

function attendedScope(userId?: string) {
  return {
    status: { in: ATTENDED_STATUSES },
    event: eventScope(userId),
  }
}

function normalizeAverage(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 0
  }

  return Math.round(value * 10) / 10
}

function topValue(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>()

  values
    .filter((value): value is string => Boolean(value && value.trim()))
    .forEach((value) => {
      counts.set(value, (counts.get(value) ?? 0) + 1)
    })

  let winner = "Unspecified"
  let winnerCount = 0

  counts.forEach((count, value) => {
    if (count > winnerCount) {
      winner = value
      winnerCount = count
    }
  })

  return { value: winner, count: winnerCount }
}

function repeatAttendanceRate(rows: Array<{ user_id: string }>) {
  if (rows.length === 0) {
    return 0
  }

  const counts = new Map<string, number>()
  rows.forEach((row) => {
    counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1)
  })

  const repeated = Array.from(counts.values()).filter((count) => count > 1).length
  return (repeated / counts.size) * 100
}

async function getDistinctUserIdsForPeriod(
  start: Date,
  end: Date,
  userId?: string,
  includeRefreshTokens?: boolean
) {
  const [checkIns, favorites, chats, refreshTokens] = await Promise.all([
    db.event_check_ins.findMany({
      where: {
        ...attendedScope(userId),
        check_in_time: { gte: start, lt: end },
      },
      select: { user_id: true },
      distinct: ["user_id"],
    }),
    db.event_favorites.findMany({
      where: {
        event: eventScope(userId),
        created_at: { gte: start, lt: end },
      },
      select: { user_id: true },
      distinct: ["user_id"],
    }),
    db.chat_messages.findMany({
      where: {
        deleted_at: null,
        created_at: { gte: start, lt: end },
        chat_group: {
          event: eventScope(userId),
        },
      },
      select: { user_id: true },
      distinct: ["user_id"],
    }),
    includeRefreshTokens
      ? db.mobile_refresh_tokens.findMany({
          where: {
            revoked_at: null,
            created_at: { gte: start, lt: end },
          },
          select: { user_id: true },
          distinct: ["user_id"],
        })
      : Promise.resolve([] as Array<{ user_id: string }>),
  ])

  const uniqueUsers = new Set<string>()
  ;[checkIns, favorites, chats, refreshTokens].forEach((collection) => {
    collection.forEach((entry) => uniqueUsers.add(entry.user_id))
  })

  return Array.from(uniqueUsers)
}

async function getMonthlyTrend(role: DashboardRole, userId?: string): Promise<DashboardTrendPoint[]> {
  const currentMonth = startOfMonth(new Date())
  const monthStarts = Array.from({ length: 6 }, (_, index) =>
    startOfMonth(addMonths(currentMonth, index - 5))
  )

  return Promise.all(
    monthStarts.map(async (monthStart) => {
      const monthEnd = startOfMonth(addMonths(monthStart, 1))

      const [users, events, attendees, favorites, chats, privateMessages] = await Promise.all([
        role === "app_admin"
          ? db.user.count({
              where: {
                createdAt: { gte: monthStart, lt: monthEnd },
              },
            })
          : getDistinctUserIdsForPeriod(monthStart, monthEnd, userId).then((rows) => rows.length),
        db.events.count({
          where: {
            ...eventScope(userId),
            status: "published",
            start_time: { gte: monthStart, lt: monthEnd },
          },
        }),
        db.event_check_ins.count({
          where: {
            ...attendedScope(userId),
            check_in_time: { gte: monthStart, lt: monthEnd },
          },
        }),
        db.event_favorites.count({
          where: {
            event: eventScope(userId),
            created_at: { gte: monthStart, lt: monthEnd },
          },
        }),
        db.chat_messages.count({
          where: {
            deleted_at: null,
            created_at: { gte: monthStart, lt: monthEnd },
            chat_group: {
              event: eventScope(userId),
            },
          },
        }),
        role === "app_admin"
          ? db.private_messages.count({
              where: {
                created_at: { gte: monthStart, lt: monthEnd },
              },
            })
          : Promise.resolve(0),
      ])

      return {
        label: monthLabel(monthStart),
        date: monthStart.toISOString(),
        users,
        events,
        attendees,
        engagement: favorites + chats + privateMessages,
      }
    })
  )
}

/**
 * Candidate pool for the "top performers" table.
 *
 * This used to take the 24 most RECENT events and then re-rank them by a
 * traction score, so a host with thirty events got a leaderboard drawn from a
 * recency window and presented as if it covered the whole portfolio — an event
 * from four months ago that outdrew everything since could not appear.
 *
 * Ordering by check-in count instead makes the pool the most-attended events,
 * which is the dominant term of the score below (attendees is weighted 2x), so
 * the final ranking is the real one. The pool stays bounded because app_admin
 * runs this across every event on the platform.
 *
 * The orderBy counts all check-ins rather than only attended statuses —
 * relation-count ordering takes no filter in Prisma. That only affects which
 * events are considered, never how they are scored; the exact attended count
 * is computed in the `_count` select below.
 */
const PERFORMANCE_POOL = 50

async function getPerformanceRows(userId?: string): Promise<DashboardPerformanceRow[]> {
  const events = await db.events.findMany({
    where: eventScope(userId),
    take: PERFORMANCE_POOL,
    orderBy: { check_ins: { _count: "desc" } },
    include: {
      categories: {
        include: {
          category: {
            select: { name: true },
          },
        },
      },
      ratings: {
        select: { rating: true },
      },
      chat_group: {
        select: {
          _count: {
            select: { messages: true },
          },
        },
      },
      _count: {
        select: {
          check_ins: {
            where: {
              status: { in: ATTENDED_STATUSES },
            },
          },
          favorites: true,
          ratings: true,
        },
      },
    },
  })

  return events
    .map((event) => {
      const averageRating =
        event.ratings.length > 0
          ? event.ratings.reduce((sum, rating) => sum + rating.rating, 0) / event.ratings.length
          : null

      const row: DashboardPerformanceRow = {
        id: event.id,
        name: event.title,
        segment: event.categories[0]?.category.name ?? "General",
        status: event.status,
        city: event.city ?? event.venue_name ?? "TBD",
        startAt: event.start_time.toISOString(),
        attendees: event._count.check_ins,
        demand: event._count.favorites,
        engagement: (event.chat_group?._count.messages ?? 0) + event._count.favorites,
        rating: averageRating ? normalizeAverage(averageRating) : null,
        capacity: event.max_capacity,
      }

      return row
    })
    .sort((left, right) => {
      const leftScore = left.attendees * 2 + left.demand + left.engagement
      const rightScore = right.attendees * 2 + right.demand + right.engagement
      return rightScore - leftScore
    })
    .slice(0, 12)
}

async function buildAdminReport(): Promise<DashboardReport> {
  const now = new Date()
  const currentStart = startOfDay(new Date(now.getTime() - 29 * DAY_IN_MS))
  const previousStart = startOfDay(new Date(now.getTime() - 59 * DAY_IN_MS))

  const [totalUsers, totalPublishedEvents, currentSignups, previousSignups, currentCheckIns, previousCheckIns] =
    await Promise.all([
      db.user.count(),
      db.events.count({
        where: {
          ...eventScope(),
          status: "published",
        },
      }),
      db.user.count({
        where: { createdAt: { gte: currentStart } },
      }),
      db.user.count({
        where: {
          createdAt: { gte: previousStart, lt: currentStart },
        },
      }),
      db.event_check_ins.count({
        where: {
          ...attendedScope(),
          check_in_time: { gte: currentStart },
        },
      }),
      db.event_check_ins.count({
        where: {
          ...attendedScope(),
          check_in_time: { gte: previousStart, lt: currentStart },
        },
      }),
    ])

  const [
    currentActiveAudienceIds,
    previousActiveAudienceIds,
    currentEventSupply,
    previousEventSupply,
    onboardedProfiles,
    checkedInUsers,
    activeHosts,
    totalHosts,
    pushReachUsers,
    ratingsAggregate,
    repeatAttendanceRows,
    publishedCities,
    performanceRows,
    trendPoints,
  ] = await Promise.all([
    getDistinctUserIdsForPeriod(currentStart, addDays(now, 1), undefined, true),
    getDistinctUserIdsForPeriod(previousStart, currentStart, undefined, true),
    db.events.count({
      where: {
        ...eventScope(),
        status: "published",
        created_at: { gte: currentStart },
      },
    }),
    db.events.count({
      where: {
        ...eventScope(),
        status: "published",
        created_at: { gte: previousStart, lt: currentStart },
      },
    }),
    db.profiles.count({
      where: { onboarded: true },
    }),
    db.event_check_ins.findMany({
      where: {
        ...attendedScope(),
        check_in_time: { gte: currentStart },
      },
      select: { user_id: true },
      distinct: ["user_id"],
    }),
    db.events.findMany({
      where: {
        ...eventScope(),
        status: "published",
      },
      select: { organizer_id: true },
      distinct: ["organizer_id"],
    }),
    db.user.count({
      where: {
        role: { in: ["organizer", "venue_owner"] },
      },
    }),
    db.push_tokens.findMany({
      select: { user_id: true },
      distinct: ["user_id"],
    }),
    db.event_ratings.aggregate({
      _avg: { rating: true },
      _count: { rating: true },
    }),
    db.event_check_ins.findMany({
      where: attendedScope(),
      select: { user_id: true },
    }),
    db.events.findMany({
      where: {
        ...eventScope(),
        status: "published",
        city: { not: null },
      },
      select: { city: true },
    }),
    getPerformanceRows(),
    getMonthlyTrend("app_admin"),
  ])

  const currentActiveAudience = currentActiveAudienceIds.length
  const previousActiveAudience = previousActiveAudienceIds.length
  const repeatedAttendance = repeatAttendanceRate(repeatAttendanceRows)

  const topCity = topValue(publishedCities.map((event) => event.city))
  const averageRating = normalizeAverage(ratingsAggregate._avg.rating)
  const metrics: DashboardMetric[] = [
    toMetric(
      "Total users",
      compactNumber(totalUsers),
      currentSignups,
      previousSignups,
      `${wholeNumber(currentSignups)} new users in the last 30 days`
    ),
    toMetric(
      "Active audience",
      compactNumber(currentActiveAudience),
      currentActiveAudience,
      previousActiveAudience,
      "Users who checked in, chatted, saved events, or refreshed a mobile session"
    ),
    toMetric(
      "Published event supply",
      compactNumber(totalPublishedEvents),
      currentEventSupply,
      previousEventSupply,
      `${wholeNumber(currentEventSupply)} published in the last 30 days`
    ),
    toMetric(
      "Check-ins",
      compactNumber(currentCheckIns),
      currentCheckIns,
      previousCheckIns,
      "Confirmed attendance across all live and completed events in the last 30 days"
    ),
  ]

  const spotlights: DashboardSpotlightCard[] = [
    {
      title: "Repeat attendance",
      value: `${oneDecimal(repeatedAttendance)}%`,
      description: "Share of attendees who have checked into more than one event.",
    },
    {
      title: "Host activation",
      value: totalHosts === 0 ? "0%" : `${wholeNumber((activeHosts.length / totalHosts) * 100)}%`,
      description: `${activeHosts.length} of ${totalHosts} organiser and venue accounts have published inventory.`,
    },
    {
      title: "Push reachable audience",
      value: totalUsers === 0 ? "0%" : `${wholeNumber((pushReachUsers.length / totalUsers) * 100)}%`,
      description: `${pushReachUsers.length} users currently have at least one push token on file.`,
    },
    {
      title: "Average event rating",
      value: ratingsAggregate._count.rating > 0 ? `${oneDecimal(averageRating)}/5` : "No ratings",
      description:
        ratingsAggregate._count.rating > 0
          ? `Based on ${wholeNumber(ratingsAggregate._count.rating)} submitted event ratings.`
          : "Ratings will populate as event feedback comes in.",
    },
  ]

  const exports: DashboardExportBundle[] = [
    {
      name: "Investor summary",
      filename: "blendn-investor-summary.csv",
      columns: ["metric", "value", "detail"],
      rows: [
        ...metrics.map((metric) => ({
          metric: metric.label,
          value: metric.value,
          detail: `${metric.delta}. ${metric.detail}`,
        })),
        ...spotlights.map((card) => ({
          metric: card.title,
          value: card.value,
          detail: card.description,
        })),
      ],
    },
    {
      name: "Growth trend",
      filename: "blendn-growth-trend.csv",
      columns: ["month", "new_users", "published_events", "check_ins", "engagement_actions"],
      rows: trendPoints.map((point) => ({
        month: point.label,
        new_users: point.users,
        published_events: point.events,
        check_ins: point.attendees,
        engagement_actions: point.engagement,
      })),
    },
    {
      name: "Event performance",
      filename: "blendn-event-performance.csv",
      columns: ["event", "segment", "status", "city", "start_at", "attendees", "demand", "engagement", "rating", "capacity"],
      rows: performanceRows.map((row) => ({
        event: row.name,
        segment: row.segment,
        status: row.status,
        city: row.city,
        start_at: row.startAt,
        attendees: row.attendees,
        demand: row.demand,
        engagement: row.engagement,
        rating: row.rating,
        capacity: row.capacity,
      })),
    },
  ]

  return {
    role: "app_admin",
    headline: "Investor & Ops Overview",
    summary:
      "Blend'n is still in MVP, so the strongest story is not vanity traffic. This view surfaces adoption, activation, host liquidity, attendance, and engagement signals you can defend in an investor conversation.",
    metrics,
    trend: {
      title: "Marketplace momentum",
      description: "Six-month view of acquisition, supply, attendance, and engagement.",
      points: trendPoints,
      defaultKey: "users",
    },
    funnel: {
      title: "Activation funnel",
      description: "The clearest MVP path from account creation to real-world attendance.",
      stages: [
        {
          label: "Total signups",
          value: totalUsers,
          detail: "All registered user accounts",
        },
        {
          label: "Onboarded profiles",
          value: onboardedProfiles,
          detail: `${totalUsers === 0 ? 0 : wholeNumber((onboardedProfiles / totalUsers) * 100)}% profile completion`,
        },
        {
          label: "Active audience 30d",
          value: currentActiveAudience,
          detail: "Checked in, chatted, saved an event, or refreshed a session",
        },
        {
          label: "Checked-in users 30d",
          value: checkedInUsers.length,
          detail: "Users who attended at least one event in the last 30 days",
        },
      ],
    },
    spotlights,
    performance: {
      title: "Top event performers",
      description:
        topCity.count > 0
          ? `Current event mix is strongest in ${topCity.value}. Use this table to support city and category expansion decisions.`
          : `Use this table to compare event traction, category fit, and attendance depth.`,
      rows: performanceRows,
    },
    exports,
  }
}

async function buildHostReport(role: Exclude<DashboardRole, "app_admin">, userId: string): Promise<DashboardReport> {
  const now = new Date()
  const currentStart = startOfDay(new Date(now.getTime() - 29 * DAY_IN_MS))
  const previousStart = startOfDay(new Date(now.getTime() - 59 * DAY_IN_MS))

  const [
    totalEvents,
    publishedEvents,
    upcomingEvents,
    currentEventSupply,
    previousEventSupply,
    currentAudienceIds,
    previousAudienceIds,
    currentDemand,
    previousDemand,
    currentChatMessages,
    previousChatMessages,
    currentCheckIns,
    ratedAggregate,
    repeatAttendanceRows,
    eventsWithCapacity,
    eventsForMix,
    ratings30d,
    performanceRows,
    trendPoints,
  ] = await Promise.all([
    db.events.count({
      where: eventScope(userId),
    }),
    db.events.count({
      where: {
        ...eventScope(userId),
        status: "published",
      },
    }),
    db.events.count({
      where: {
        ...eventScope(userId),
        status: "published",
        start_time: { gte: now },
      },
    }),
    db.events.count({
      where: {
        ...eventScope(userId),
        status: "published",
        created_at: { gte: currentStart },
      },
    }),
    db.events.count({
      where: {
        ...eventScope(userId),
        status: "published",
        created_at: { gte: previousStart, lt: currentStart },
      },
    }),
    getDistinctUserIdsForPeriod(currentStart, addDays(now, 1), userId),
    getDistinctUserIdsForPeriod(previousStart, currentStart, userId),
    db.event_favorites.count({
      where: {
        event: eventScope(userId),
        created_at: { gte: currentStart },
      },
    }),
    db.event_favorites.count({
      where: {
        event: eventScope(userId),
        created_at: { gte: previousStart, lt: currentStart },
      },
    }),
    db.chat_messages.count({
      where: {
        deleted_at: null,
        created_at: { gte: currentStart },
        chat_group: {
          event: eventScope(userId),
        },
      },
    }),
    db.chat_messages.count({
      where: {
        deleted_at: null,
        created_at: { gte: previousStart, lt: currentStart },
        chat_group: {
          event: eventScope(userId),
        },
      },
    }),
    db.event_check_ins.count({
      where: {
        ...attendedScope(userId),
        check_in_time: { gte: currentStart },
      },
    }),
    db.event_ratings.aggregate({
      where: {
        event: eventScope(userId),
      },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    db.event_check_ins.findMany({
      where: attendedScope(userId),
      select: { user_id: true },
    }),
    db.events.findMany({
      where: {
        ...eventScope(userId),
        max_capacity: { not: null },
      },
      select: {
        max_capacity: true,
        _count: {
          select: {
            check_ins: {
              where: {
                status: { in: ATTENDED_STATUSES },
              },
            },
          },
        },
      },
    }),
    db.events.findMany({
      where: eventScope(userId),
      select: {
        city: true,
        venue_name: true,
      },
    }),
    db.event_ratings.count({
      where: {
        event: eventScope(userId),
        created_at: { gte: currentStart },
      },
    }),
    getPerformanceRows(userId),
    getMonthlyTrend(role, userId),
  ])

  const currentAudience = currentAudienceIds.length
  const previousAudience = previousAudienceIds.length
  const repeatedAttendance = repeatAttendanceRate(repeatAttendanceRows)

  const averageFillRate =
    eventsWithCapacity.length === 0
      ? 0
      : eventsWithCapacity.reduce((sum, event) => {
          const capacity = event.max_capacity ?? 0
          if (capacity <= 0) {
            return sum
          }

          return sum + Math.min(100, (event._count.check_ins / capacity) * 100)
        }, 0) / eventsWithCapacity.length

  const topCity = topValue(eventsForMix.map((event) => event.city))
  const topVenue = topValue(eventsForMix.map((event) => event.venue_name))
  const averageRating = normalizeAverage(ratedAggregate._avg.rating)

  const metrics: DashboardMetric[] = [
    toMetric(
      "Events in portfolio",
      compactNumber(totalEvents),
      currentEventSupply,
      previousEventSupply,
      `${wholeNumber(publishedEvents)} published and ${wholeNumber(upcomingEvents)} upcoming`
    ),
    toMetric(
      "Unique audience 30d",
      compactNumber(currentAudience),
      currentAudience,
      previousAudience,
      "Distinct users who checked in, saved, or chatted in your event ecosystem"
    ),
    toMetric(
      "Demand signals 30d",
      compactNumber(currentDemand),
      currentDemand,
      previousDemand,
      "Event saves and interest captured in the last 30 days"
    ),
    toMetric(
      "Chat activity 30d",
      compactNumber(currentChatMessages),
      currentChatMessages,
      previousChatMessages,
      `${wholeNumber(currentCheckIns)} check-ins across your portfolio in the last 30 days`
    ),
  ]

  const spotlights: DashboardSpotlightCard[] = [
    {
      title: "Repeat attendee rate",
      value: `${oneDecimal(repeatedAttendance)}%`,
      description: "Audience returning for more than one event in your portfolio.",
    },
    {
      title: "Average fill rate",
      value: `${oneDecimal(averageFillRate)}%`,
      description: "Based on checked-in attendees versus stated max capacity.",
    },
    {
      title: "Average event rating",
      value: ratedAggregate._count.rating > 0 ? `${oneDecimal(averageRating)}/5` : "No ratings",
      description:
        ratedAggregate._count.rating > 0
          ? `${wholeNumber(ratedAggregate._count.rating)} ratings submitted across your events.`
          : "Ratings will appear once attendees leave event feedback.",
    },
    {
      title: role === "venue_owner" ? "Top venue" : "Top city",
      value: role === "venue_owner" ? topVenue.value : topCity.value,
      description:
        role === "venue_owner"
          ? "Venue name appearing most often across your managed event inventory."
          : "City showing the highest concentration of your current event portfolio.",
    },
  ]

  const exports: DashboardExportBundle[] = [
    {
      name: "Performance summary",
      filename: `blendn-${role}-summary.csv`,
      columns: ["metric", "value", "detail"],
      rows: [
        ...metrics.map((metric) => ({
          metric: metric.label,
          value: metric.value,
          detail: `${metric.delta}. ${metric.detail}`,
        })),
        ...spotlights.map((card) => ({
          metric: card.title,
          value: card.value,
          detail: card.description,
        })),
      ],
    },
    {
      name: "Trend lines",
      filename: `blendn-${role}-trend.csv`,
      columns: ["month", "audience", "published_events", "check_ins", "engagement_actions"],
      rows: trendPoints.map((point) => ({
        month: point.label,
        audience: point.users,
        published_events: point.events,
        check_ins: point.attendees,
        engagement_actions: point.engagement,
      })),
    },
    {
      name: "Event performance",
      filename: `blendn-${role}-events.csv`,
      columns: ["event", "segment", "status", "city", "start_at", "attendees", "demand", "engagement", "rating", "capacity"],
      rows: performanceRows.map((row) => ({
        event: row.name,
        segment: row.segment,
        status: row.status,
        city: row.city,
        start_at: row.startAt,
        attendees: row.attendees,
        demand: row.demand,
        engagement: row.engagement,
        rating: row.rating,
        capacity: row.capacity,
      })),
    },
  ]

  return {
    role,
    headline: role === "venue_owner" ? "Venue Performance Overview" : "Organiser Performance Overview",
    summary:
      role === "venue_owner"
        ? "Use this view to show venue partners how inventory is performing: portfolio depth, audience pull, attendance conversion, and feedback quality."
        : "This view concentrates on supply quality, audience pull, repeat attendance, and event-level traction so organisers can improve the next slate of events.",
    metrics,
    trend: {
      title: "Portfolio momentum",
      description: "Audience, event supply, attendance, and engagement over the last six months.",
      points: trendPoints,
      defaultKey: "attendees",
    },
    funnel: {
      title: "Demand funnel",
      description: "How your event pipeline converts interest into attendance and feedback.",
      stages: [
        {
          label: "Total events",
          value: totalEvents,
          detail: "All events currently tied to your account",
        },
        {
          label: "Published events",
          value: publishedEvents,
          detail: `${totalEvents === 0 ? 0 : wholeNumber((publishedEvents / totalEvents) * 100)}% of total portfolio`,
        },
        {
          label: "Audience 30d",
          value: currentAudience,
          detail: "Distinct users who engaged with your event portfolio",
        },
        {
          label: "Ratings 30d",
          value: ratings30d,
          detail: "Fresh feedback submitted during the current 30-day window",
        },
      ],
    },
    spotlights,
    performance: {
      title: "Event leaderboard",
      description:
        role === "venue_owner"
          ? "Compare which events are driving attendance, demand, and chat energy inside your venues."
          : "Compare which events are creating the strongest mix of attendance, demand, and conversation.",
      rows: performanceRows,
    },
    exports,
  }
}

export async function getDashboardReport(role: DashboardRole, userId?: string) {
  if (role === "app_admin") {
    return buildAdminReport()
  }

  if (!userId) {
    throw new Error("User ID is required for scoped dashboard reports")
  }

  return buildHostReport(role, userId)
}

export async function getDashboardStats(userId?: string) {
  try {
    const scopedEventWhere = {
      deleted_at: null,
      ...(userId ? { organizer_id: userId } : {}),
    }

    const [totalEvents, publishedEvents, upcomingEvents] = await Promise.all([
      db.events.count({ where: scopedEventWhere }),
      db.events.count({ where: { ...scopedEventWhere, status: "published" } }),
      db.events.count({
        where: {
          ...scopedEventWhere,
          status: "published",
          start_time: { gte: new Date() },
        },
      }),
    ])

    const lastMonth = new Date()
    lastMonth.setMonth(lastMonth.getMonth() - 1)

    const previousMonth = new Date()
    previousMonth.setMonth(previousMonth.getMonth() - 2)

    const [eventsLastMonth, eventsPreviousMonth] = await Promise.all([
      db.events.count({
        where: { ...scopedEventWhere, created_at: { gte: lastMonth } },
      }),
      db.events.count({
        where: {
          ...scopedEventWhere,
          created_at: { gte: previousMonth, lt: lastMonth },
        },
      }),
    ])

    const eventGrowth =
      eventsPreviousMonth === 0
        ? 100
        : Math.round(((eventsLastMonth - eventsPreviousMonth) / eventsPreviousMonth) * 100)

    if (userId) {
      const totalCheckIns = await db.event_check_ins.count({
        where: { event: { organizer_id: userId } },
      })
      return {
        totalEvents,
        publishedEvents,
        upcomingEvents,
        totalCheckIns,
        totalUsers: null,
        eventGrowth,
        userGrowth: null,
      }
    }

    const [totalUsers, usersLastMonth, usersPreviousMonth] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { createdAt: { gte: lastMonth } } }),
      db.user.count({
        where: { createdAt: { gte: previousMonth, lt: lastMonth } },
      }),
    ])

    const userGrowth =
      usersPreviousMonth === 0
        ? 100
        : Math.round(((usersLastMonth - usersPreviousMonth) / usersPreviousMonth) * 100)

    return {
      totalEvents,
      publishedEvents,
      upcomingEvents,
      totalCheckIns: null,
      totalUsers,
      eventGrowth,
      userGrowth,
    }
  } catch (error) {
    logger.error("Error fetching dashboard stats", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to fetch dashboard stats")
  }
}

export async function getEventsOverTime(days: number = 90, userId?: string) {
  try {
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    const events = await db.events.findMany({
      where: {
        created_at: { gte: startDate },
        ...(userId ? { organizer_id: userId } : {}),
      },
      select: { created_at: true },
      orderBy: { created_at: "asc" },
    })

    const groupedData: Record<string, { date: string; events: number }> = {}

    for (let index = 0; index < days; index++) {
      const date = new Date()
      date.setDate(date.getDate() - index)
      const dateStr = date.toISOString().split("T")[0]
      groupedData[dateStr] = { date: dateStr, events: 0 }
    }

    events.forEach((event) => {
      const dateStr = event.created_at.toISOString().split("T")[0]
      if (groupedData[dateStr]) {
        groupedData[dateStr].events += 1
      }
    })

    return Object.values(groupedData).sort(
      (left, right) => new Date(left.date).getTime() - new Date(right.date).getTime()
    )
  } catch (error) {
    logger.error("Error fetching events over time", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to fetch events over time")
  }
}

export async function getRecentEvents(limit: number = 10, userId?: string) {
  try {
    const events = await db.events.findMany({
      take: limit,
      where: {
        deleted_at: null,
        ...(userId ? { organizer_id: userId } : {}),
      },
      orderBy: { created_at: "desc" },
      include: {
        organizer: {
          select: { name: true, email: true },
        },
        categories: {
          include: { category: true },
        },
        _count: {
          select: { check_ins: true, favorites: true },
        },
      },
    })

    return events.map((event) => ({
      id: event.id,
      title: event.title,
      slug: event.slug,
      status: event.status,
      visibility: event.visibility,
      start_time: event.start_time,
      end_time: event.end_time,
      city: event.city,
      max_capacity: event.max_capacity,
      current_capacity: event.current_capacity,
      organizer: event.organizer,
      categories: event.categories.map((item) => item.category.name),
      check_ins: event._count.check_ins,
      favorites: event._count.favorites,
      created_at: event.created_at,
    }))
  } catch (error) {
    logger.error("Error fetching recent events", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to fetch recent events")
  }
}

export async function getTopCategories() {
  try {
    const categories = await db.categories.findMany({
      include: {
        _count: { select: { events: true } },
      },
      orderBy: { events: { _count: "desc" } },
      take: 5,
    })

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      eventCount: category._count.events,
    }))
  } catch (error) {
    logger.error("Error fetching top categories", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to fetch top categories")
  }
}
