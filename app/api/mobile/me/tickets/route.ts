import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { ticketingOn } from "@/lib/env"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { myTicketsView } from "@/lib/ticket-views"

/**
 * GET /api/mobile/me/tickets?eventId= — my tickets from paid orders, each
 * with its event, for the pass to draw offline (contract §6, §8.4). The app
 * caches the answer per account and wipes it on sign-out.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Invalid or expired token")
    if (!ticketingOn()) return notFoundResponse()
    const limited = await rateLimit(request, userLimit("read", "my-tickets", user.userId))
    if (limited) return limited
    const eventId = request.nextUrl.searchParams.get("eventId")
    if (eventId !== null && !isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
    return successResponse(await myTicketsView(user.userId, eventId))
  } catch (error) {
    logger.error("My tickets error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load tickets")
  }
}
