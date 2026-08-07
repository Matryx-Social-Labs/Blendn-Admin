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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  // Rate limit: max 10 checkouts per user per 10 minutes
  const rateLimited = await rateLimit(request, {
    windowMs: 10 * 60 * 1000,
    maxRequests: 10,
    keyGenerator: (req) => {
      const auth = req.headers.get("authorization") || "anon"
      return `checkout:${auth.slice(-16)}`
    },
  })
  if (rateLimited) return rateLimited

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
