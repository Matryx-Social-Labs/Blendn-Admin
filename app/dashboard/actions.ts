"use server"

import { db } from "@/lib/db"

export async function getDashboardStats() {
  try {
    const [
      totalEvents,
      totalUsers,
      publishedEvents,
      upcomingEvents,
    ] = await Promise.all([
      db.events.count(),
      db.user.count(),
      db.events.count({ where: { status: "published" } }),
      db.events.count({
        where: {
          status: "published",
          start_time: {
            gte: new Date(),
          },
        },
      }),
    ])

    // Calculate growth percentages (comparing with last month)
    const lastMonth = new Date()
    lastMonth.setMonth(lastMonth.getMonth() - 1)

    const previousMonth = new Date()
    previousMonth.setMonth(previousMonth.getMonth() - 2)

    const [eventsLastMonth, eventsPreviousMonth] = await Promise.all([
      db.events.count({
        where: {
          created_at: {
            gte: lastMonth,
          },
        },
      }),
      db.events.count({
        where: {
          created_at: {
            gte: previousMonth,
            lt: lastMonth,
          },
        },
      }),
    ])

    const [usersLastMonth, usersPreviousMonth] = await Promise.all([
      db.user.count({
        where: {
          createdAt: {
            gte: lastMonth,
          },
        },
      }),
      db.user.count({
        where: {
          createdAt: {
            gte: previousMonth,
            lt: lastMonth,
          },
        },
      }),
    ])

    const eventGrowth =
      eventsPreviousMonth === 0
        ? 100
        : Math.round(
            ((eventsLastMonth - eventsPreviousMonth) / eventsPreviousMonth) * 100
          )

    const userGrowth =
      usersPreviousMonth === 0
        ? 100
        : Math.round(
            ((usersLastMonth - usersPreviousMonth) / usersPreviousMonth) * 100
          )

    return {
      totalEvents,
      totalUsers,
      publishedEvents,
      upcomingEvents,
      eventGrowth,
      userGrowth,
    }
  } catch (error) {
    console.error("Error fetching dashboard stats:", error)
    throw new Error("Failed to fetch dashboard stats")
  }
}

export async function getEventsOverTime(days: number = 90) {
  try {
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    const events = await db.events.findMany({
      where: {
        created_at: {
          gte: startDate,
        },
      },
      select: {
        created_at: true,
      },
      orderBy: {
        created_at: "asc",
      },
    })

    // Group events by date
    const groupedData: Record<string, { date: string; events: number }> = {}

    for (let i = 0; i < days; i++) {
      const date = new Date()
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().split("T")[0]
      groupedData[dateStr] = { date: dateStr, events: 0 }
    }

    events.forEach((event) => {
      const dateStr = event.created_at.toISOString().split("T")[0]
      if (groupedData[dateStr]) {
        groupedData[dateStr].events++
      }
    })

    return Object.values(groupedData).sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )
  } catch (error) {
    console.error("Error fetching events over time:", error)
    throw new Error("Failed to fetch events over time")
  }
}

export async function getRecentEvents(limit: number = 10) {
  try {
    const events = await db.events.findMany({
      take: limit,
      orderBy: {
        created_at: "desc",
      },
      include: {
        organizer: {
          select: {
            name: true,
            email: true,
          },
        },
        categories: {
          include: {
            category: true,
          },
        },
        _count: {
          select: {
            check_ins: true,
            favorites: true,
          },
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
      categories: event.categories.map((ec) => ec.category.name),
      check_ins: event._count.check_ins,
      favorites: event._count.favorites,
      created_at: event.created_at,
    }))
  } catch (error) {
    console.error("Error fetching recent events:", error)
    throw new Error("Failed to fetch recent events")
  }
}

export async function getTopCategories() {
  try {
    const categories = await db.categories.findMany({
      include: {
        _count: {
          select: {
            events: true,
          },
        },
      },
      orderBy: {
        events: {
          _count: "desc",
        },
      },
      take: 5,
    })

    return categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      eventCount: cat._count.events,
    }))
  } catch (error) {
    console.error("Error fetching top categories:", error)
    throw new Error("Failed to fetch top categories")
  }
}
