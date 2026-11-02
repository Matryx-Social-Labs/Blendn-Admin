import { NextRequest } from "next/server"

import { isUuid, readJson } from "@/lib/api-input"
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { ticketingOn } from "@/lib/env"
import { attendeeEventAccess, eventAccessResponse } from "@/lib/event-access"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { networkLimit, rateLimit, userLimit } from "@/lib/rate-limit"
import { quoteTickets } from "@/lib/ticket-holds"
import { linesSchema, quoteView, refusalResponse, toReserveLines } from "@/lib/ticket-views"

/**
 * POST /api/mobile/events/:eventId/ticket-quote — what these tickets would
 * cost now, fees and all, with nothing held (contract §2). The app asks on
 * every stepper change, debounced, so the user limit is the read one; the
 * network limit stops a farm of accounts pricing the room.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Invalid or expired token")
    if (!ticketingOn()) return notFoundResponse()
    const limited =
      (await rateLimit(request, userLimit("read", "ticket-quote", user.userId))) ??
      (await rateLimit(request, networkLimit("ticket-quote-net", 60_000, 240)))
    if (limited) return limited

    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
    // The RSVP's door, and its answer, for every refusal (security review, gate parity): whoever may not say
    // "going" may not buy their way in. `reserveTickets` asks the same again, as the backstop.
    const denied = await attendeeEventAccess(user.userId, eventId, "participate")
    if (denied) return eventAccessResponse(denied)

    const parsed = linesSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const quoted = await quoteTickets({ eventId, buyerId: user.userId, lines: toReserveLines(parsed.data.lines) })
    if (!quoted.ok) return refusalResponse(quoted.reason)
    return successResponse(await quoteView(quoted.breakdown, quoted.market))
  } catch (error) {
    logger.error("Ticket quote error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to price the tickets")
  }
}
