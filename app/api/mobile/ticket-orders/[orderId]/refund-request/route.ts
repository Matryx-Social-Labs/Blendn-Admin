import { NextRequest } from "next/server"

import { errorResponse, notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { buyerRefund } from "@/lib/ticket-refunds"
import { orderView, refundRefusalResponse, REFUND_STARTED_SENTENCE } from "@/lib/ticket-views"

/**
 * POST /api/mobile/ticket-orders/:orderId/refund-request — the buyer's own
 * refund of a paid order, automatic inside the event's refund window
 * (SCRUM-1113): the full ticket price, the whole order. The order as it now
 * is, with its `refund`, and the sentence to show. Asking again is the same
 * 200; anyone but the buyer gets the 404 of an order that does not exist.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("heavy", "ticket-refund-request", user.userId))
    if (limited) return limited
    const { orderId } = await params
    const answer = await buyerRefund(orderId, user.userId)
    if (!answer.ok) {
      if (answer.reason === "ticketing_off") return notFoundResponse()
      if (answer.reason === "not_found") return notFoundResponse("Order not found")
      if (answer.reason === "payments_off") return errorResponse("Refunds are not available right now", 503)
      return refundRefusalResponse(answer.reason)
    }
    return successResponse({ ...(await orderView(orderId, user.userId)), message: REFUND_STARTED_SENTENCE })
  } catch (error) {
    logger.error("Ticket refund request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to start the refund")
  }
}
