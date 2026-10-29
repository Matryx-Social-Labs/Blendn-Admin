import { logger } from "@/lib/logger"
import { placeRsvp, promoteFromWaitlist } from "@/lib/waitlist"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { db } from "@/lib/db"
import { attendeeEventAccess, eventAccessResponse } from "@/lib/event-access"
import {
  ErrorCode,
  successResponse,
  errorResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson, isUuid } from "@/lib/api-input"

/** What the person is told when they try to join a night that was called off. */
const EVENT_CANCELLED_SENTENCE = "This event has been cancelled, so it isn’t taking RSVPs any more."

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
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const denied = await attendeeEventAccess(user.userId, eventId, "participate")
    if (denied) return eventAccessResponse(denied)

    // An empty object means "going", so a body that isn't an object must not read as one.
    const body = await readJson(request)
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return errorResponse("Invalid JSON body", 400)
    }
    const status: "going" | "maybe" | "not_going" = (body as { status?: "going" | "maybe" | "not_going" }).status || "going"

    if (!["going", "maybe", "not_going"].includes(status)) {
      return errorResponse("Invalid RSVP status", 400)
    }

    // A night that was called off takes no new "going" or "maybe". Saying not_going stays open (and so does
    // DELETE below): somebody who got in before the cancellation must be able to get out. A deleted or draft
    // event never reaches here: `attendeeEventAccess` answered 404.
    if (status !== "not_going") {
      const event = await db.events.findUnique({ where: { id: eventId }, select: { status: true } })
      if (event?.status === "cancelled") {
        return errorResponse(EVENT_CANCELLED_SENTENCE, 409, undefined, ErrorCode.EVENT_CANCELLED)
      }
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
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    // A draft or a stranger's private event is not found here either — this
    // answered a real `going` count for any id. Withdrawing is never refused
    // on age: somebody who got in before the rule must be able to get out.
    const denied = await attendeeEventAccess(user.userId, eventId, "view")
    if (denied?.kind === "not_found") return eventAccessResponse(denied)

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
