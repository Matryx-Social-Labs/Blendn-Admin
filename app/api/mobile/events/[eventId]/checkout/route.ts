import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import { emitEventCheckOut } from "@/lib/socket-server"
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
      select: { id: true, title: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Find the user's active check-in for this event
    const checkIn = await db.event_check_ins.findUnique({
      where: {
        event_id_user_id: {
          event_id: eventId,
          user_id: user.userId,
        },
      },
    })

    if (!checkIn) {
      return errorResponse("You are not checked in to this event", 400)
    }

    if (checkIn.status !== "checked_in") {
      return errorResponse(
        `Cannot checkout: current status is "${checkIn.status}"`,
        400
      )
    }

    // Update the check-in status
    const now = new Date()
    const updatedCheckIn = await db.event_check_ins.update({
      where: {
        id: checkIn.id,
      },
      data: {
        status: "checked_out",
        check_out_time: now,
        updated_at: now,
      },
      select: {
        id: true,
        status: true,
        check_in_time: true,
        check_out_time: true,
        event: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    })

    // Emit real-time event
    emitEventCheckOut(eventId, user.userId)

    return successResponse({
      message: "Successfully checked out",
      checkIn: updatedCheckIn,
    })
  } catch (error) {
    console.error("Checkout error:", error)
    return serverErrorResponse("Failed to checkout from event")
  }
}
