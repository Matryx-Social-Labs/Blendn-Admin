import { logger } from "@/lib/logger"
import { placeRsvp, promoteFromWaitlist } from "@/lib/waitlist"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { db } from "@/lib/db"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "rsvp", user.userId))
    if (limited) return limited

    const { eventId } = await params
    if (!uuidRegex.test(eventId)) return errorResponse("Invalid event ID format", 400)

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true },
    })
    if (!event) return notFoundResponse("Event not found")

    const body = await request.json()
    const status: "going" | "maybe" | "not_going" = body.status || "going"

    if (!["going", "maybe", "not_going"].includes(status)) {
      return errorResponse("Invalid RSVP status", 400)
    }

    // Capacity was not enforced here at all: anyone could say "going" to a
    // 100-capacity room without limit, which made `going` useless as a planning
    // number. `placeRsvp` waitlists instead of refusing, and promotes whoever
    // is next when this RSVP frees a seat.
    const { status: placed, goingCount } = await placeRsvp(eventId, user.userId, status)

    return successResponse({ rsvpStatus: placed, rsvpCount: goingCount })
  } catch (error) {
    logger.error("RSVP error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to update RSVP")
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "rsvp", user.userId))
    if (limited) return limited

    const { eventId } = await params
    if (!uuidRegex.test(eventId)) return errorResponse("Invalid event ID format", 400)

    await db.event_rsvps.deleteMany({
      where: { event_id: eventId, user_id: user.userId },
    })

    // Cancelling releases a seat, so somebody on the waitlist gets it.
    await promoteFromWaitlist(eventId)

    const rsvpCount = await db.event_rsvps.count({
      where: { event_id: eventId, status: "going" },
    })

    return successResponse({ rsvpStatus: null, rsvpCount })
  } catch (error) {
    logger.error("RSVP cancel error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to cancel RSVP")
  }
}
