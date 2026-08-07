import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { getOccupancy } from "@/lib/occupancy"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const { eventId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: {
        id: true,
        organizer_id: true,
        max_capacity: true,
        start_time: true,
        end_time: true,
      },
    })

    const occupancy = await getOccupancy(eventId)

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Only organiser or admin can view analytics
    if (event.organizer_id !== authUser.userId) {
      const user = await db.user.findUnique({
        where: { id: authUser.userId },
        select: { role: true },
      })
      if (user?.role !== "app_admin") {
        return forbiddenResponse("Only the event organiser can view analytics")
      }
    }

    // Run all analytics queries in parallel
    const [
      totalCheckIns,
      checkedInNow,
      totalInterested,
      totalRatings,
      avgRating,
      checkInsByHour,
    ] = await Promise.all([
      // Total unique check-ins
      db.event_check_ins.count({
        where: { event_id: eventId, status: { in: ["checked_in", "checked_out"] } },
      }),

      // Currently checked in
      db.event_check_ins.count({
        where: { event_id: eventId, status: "checked_in" },
      }),

      // Total interested (favorites)
      db.event_favorites.count({
        where: { event_id: eventId },
      }),

      // Total ratings
      db.event_ratings.count({
        where: { event_id: eventId },
      }),

      // Average rating
      db.event_ratings.aggregate({
        where: { event_id: eventId },
        _avg: { rating: true },
      }),

      // Check-ins grouped by hour for timeline
      db.event_check_ins.findMany({
        where: {
          event_id: eventId,
          check_in_time: { not: null },
        },
        select: { check_in_time: true },
        orderBy: { check_in_time: "asc" },
      }),
    ])

    // Build hourly check-in timeline
    const hourlyTimeline: Record<string, number> = {}
    for (const ci of checkInsByHour) {
      if (ci.check_in_time) {
        const hour = new Date(ci.check_in_time)
        hour.setMinutes(0, 0, 0)
        const key = hour.toISOString()
        hourlyTimeline[key] = (hourlyTimeline[key] || 0) + 1
      }
    }

    const conversionRate =
      totalInterested > 0
        ? Math.round((totalCheckIns / totalInterested) * 100)
        : 0

    return successResponse({
      eventId,
      summary: {
        totalCheckIns,
        checkedInNow,
        totalInterested,
        totalRatings,
        averageRating: avgRating._avg.rating
          ? Math.round(avgRating._avg.rating * 10) / 10
          : null,
        conversionRate,
        capacityUsed: event.max_capacity
          ? Math.round((occupancy.guestsInside / event.max_capacity) * 100)
          : null,
      },
      checkInTimeline: Object.entries(hourlyTimeline).map(([hour, count]) => ({
        hour,
        count,
      })),
    })
  } catch (error) {
    logger.error("Event analytics error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to fetch event analytics")
  }
}
