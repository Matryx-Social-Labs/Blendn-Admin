import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Get all active check-ins for the user
    const checkIns = await db.event_check_ins.findMany({
      where: {
        user_id: authUser.userId,
        status: "checked_in",
      },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            slug: true,
            cover_image_url: true,
            start_time: true,
            end_time: true,
            venue_name: true,
            address: true,
            city: true,
            status: true,
          },
        },
      },
      orderBy: { check_in_time: "desc" },
    })

    return successResponse({
      checkIns: checkIns.map((c) => ({
        id: c.id,
        eventId: c.event_id,
        checkInTime: c.check_in_time,
        event: {
          id: c.event.id,
          title: c.event.title,
          slug: c.event.slug,
          coverImageUrl: c.event.cover_image_url,
          startTime: c.event.start_time,
          endTime: c.event.end_time,
          venueName: c.event.venue_name,
          address: c.event.address,
          city: c.event.city,
          status: c.event.status,
        },
      })),
    })
  } catch (error) {
    console.error("Get active check-ins error:", error)
    return serverErrorResponse("Failed to get active check-ins")
  }
}
