import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Parse pagination params
    const searchParams = request.nextUrl.searchParams
    const page = parseInt(searchParams.get("page") || "1")
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 100)

    // Check if event exists
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Get total count
    const totalCount = await db.event_check_ins.count({
      where: {
        event_id: eventId,
        status: "checked_in",
      },
    })

    // Fetch check-ins with user info
    const checkIns = await db.event_check_ins.findMany({
      where: {
        event_id: eventId,
        status: "checked_in",
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
            profile: {
              select: {
                age: true,
                location: true,
              },
            },
          },
        },
      },
      orderBy: { check_in_time: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    })

    return successResponse({
      attendees: checkIns.map((c) => ({
        userId: c.user.id,
        name: c.user.name,
        image: c.user.image,
        age: c.user.profile?.age,
        location: c.user.profile?.location,
        checkInTime: c.check_in_time,
      })),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
    })
  } catch (error) {
    console.error("Get check-ins error:", error)
    return serverErrorResponse("Failed to get attendees")
  }
}
