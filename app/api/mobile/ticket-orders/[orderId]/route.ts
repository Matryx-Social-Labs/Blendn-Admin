import { NextRequest, NextResponse } from "next/server"

import { isUuid } from "@/lib/api-input"
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { ticketingOn } from "@/lib/env"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { cancelHold } from "@/lib/ticket-holds"
import { orderView } from "@/lib/ticket-views"

type Params = { params: Promise<{ orderId: string }> }

/**
 * GET /api/mobile/ticket-orders/:orderId — the buyer's order and, once paid,
 * its tickets (contract §5). The app polls this after the pay page closes.
 * Anyone but the buyer gets a 404, as for an order that does not exist.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Invalid or expired token")
    if (!ticketingOn()) return notFoundResponse()
    const limited = await rateLimit(request, userLimit("read", "ticket-order-read", user.userId))
    if (limited) return limited
    const view = await orderView((await params).orderId, user.userId)
    return view ? successResponse(view) : notFoundResponse("Order not found")
  } catch (error) {
    logger.error("Ticket order read error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to read the order")
  }
}

/**
 * DELETE /api/mobile/ticket-orders/:orderId — "Let them go" (contract §8.3):
 * the buyer gives a pending hold back now. 204; a 409 for an order that is no
 * longer pending; a 404 for anyone else's.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Invalid or expired token")
    if (!ticketingOn()) return notFoundResponse()
    const limited = await rateLimit(request, userLimit("write", "ticket-order-release", user.userId))
    if (limited) return limited
    const { orderId } = await params
    if (!isUuid(orderId)) return notFoundResponse("Order not found")
    const order = await db.ticket_orders.findFirst({ where: { id: orderId, buyer_id: user.userId }, select: { id: true } })
    if (!order) return notFoundResponse("Order not found")
    // Conditional on pending under the order's lock, so a payment landing now wins and this answers 409.
    if ((await cancelHold(orderId)) === 0) return errorResponse("This order is no longer held", 409, "not_pending")
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error("Ticket hold release error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to release the hold")
  }
}
