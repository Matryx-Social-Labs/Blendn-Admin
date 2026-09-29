import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import { performCheckout } from "@/lib/checkout"
import { rateLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { isUuid } from "@/lib/api-input"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    // 10 checkouts per person per 10 minutes. Keyed on the user, not the
    // token's tail, which changes with every refresh (SCRUM-439).
    const rateLimited = await rateLimit(request, {
      windowMs: 10 * 60 * 1000,
      maxRequests: 10,
      keyGenerator: () => `checkout:${user.userId}`,
    })
    if (rateLimited) return rateLimited

    const { eventId } = await params

    if (!isUuid(eventId)) {
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

    // The occurrence they are currently inside, not merely one they attended.
    // A five-day conference has five check-ins for one person; checking out
    // of Monday when it is Wednesday would be wrong.
    const checkIn = await db.event_check_ins.findFirst({
      where: { event_id: eventId, user_id: user.userId, status: "checked_in" },
      orderBy: { check_in_time: "desc" },
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

    // Through the shared path, so this and the sweeper cannot drift.
    const now = new Date()
    await performCheckout(checkIn.id, "manual", now)

    const updatedCheckIn = await db.event_check_ins.findUniqueOrThrow({
      where: { id: checkIn.id },
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

    // No counter to decrement. Occupancy is counted from these rows
    // (lib/occupancy.ts), so checking out *is* the decrement.


    return successResponse({
      message: "Successfully checked out",
      checkIn: updatedCheckIn,
    })
  } catch (error) {
    logger.error("Checkout error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to checkout from event")
  }
}
