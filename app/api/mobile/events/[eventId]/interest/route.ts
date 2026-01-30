import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import { emitEventInterestUpdate } from "@/lib/socket-server"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const { eventId } = await params

    // Validate eventId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(eventId)) {
      return errorResponse("Invalid event ID format", 400)
    }

    // Check if event exists
    const event = await db.events.findUnique({
      where: { id: eventId },
      select: { id: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Check if user already has this event as a favorite (interest)
    const existingFavorite = await db.event_favorites.findUnique({
      where: {
        event_id_user_id: {
          event_id: eventId,
          user_id: user.userId,
        },
      },
    })

    let interested: boolean

    if (existingFavorite) {
      // Remove the favorite (toggle off)
      await db.event_favorites.delete({
        where: {
          id: existingFavorite.id,
        },
      })
      interested = false
    } else {
      // Add the favorite (toggle on)
      await db.event_favorites.create({
        data: {
          event_id: eventId,
          user_id: user.userId,
        },
      })
      interested = true
    }

    // Get the updated interest count
    const interestCount = await db.event_favorites.count({
      where: { event_id: eventId },
    })

    // Emit real-time event
    emitEventInterestUpdate(eventId, user.userId, interested, interestCount)

    return successResponse({
      interested,
      interestCount,
    })
  } catch (error) {
    console.error("Toggle interest error:", error)
    return serverErrorResponse("Failed to toggle interest")
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const { eventId } = await params

    // Validate eventId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(eventId)) {
      return errorResponse("Invalid event ID format", 400)
    }

    // Check if user is interested
    const favorite = await db.event_favorites.findUnique({
      where: {
        event_id_user_id: {
          event_id: eventId,
          user_id: user.userId,
        },
      },
    })

    // Get the interest count
    const interestCount = await db.event_favorites.count({
      where: { event_id: eventId },
    })

    return successResponse({
      interested: !!favorite,
      interestCount,
    })
  } catch (error) {
    console.error("Get interest error:", error)
    return serverErrorResponse("Failed to get interest status")
  }
}
