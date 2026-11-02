import { NextRequest } from "next/server"

import { isUuid, readJson } from "@/lib/api-input"
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { razorpayKeys, ticketingOn } from "@/lib/env"
import { attendeeEventAccess } from "@/lib/event-access"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { networkLimit, rateLimit, userLimit } from "@/lib/rate-limit"
import { createTicketOrder } from "@/lib/razorpay"
import { cancelHold, reserveTickets } from "@/lib/ticket-holds"
import { payUrlFor } from "@/lib/ticket-pay-token"
import { linesSchema, refusalResponse, toReserveLines } from "@/lib/ticket-views"

/**
 * POST /api/mobile/events/:eventId/ticket-orders — hold the tickets for ten
 * minutes and open a Razorpay order for them (contract §3).
 *
 * The amount Razorpay is asked for is `ticket_orders.total_minor` read back
 * from the row `reserveTickets` wrote, never a client figure. If Razorpay
 * cannot make the order the hold is given back at once: nobody could pay it.
 * The answer's `payUrl` carries a 15-minute token bound to the order and its
 * buyer, because the browser that opens it has no JWT.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Invalid or expired token")
    if (!ticketingOn()) return notFoundResponse()
    const limited =
      (await rateLimit(request, userLimit("heavy", "ticket-order", user.userId))) ??
      (await rateLimit(request, networkLimit("ticket-order-net", 60_000, 30)))
    if (limited) return limited
    if (!razorpayKeys()) return errorResponse("Payments are not available right now", 503)

    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
    if ((await attendeeEventAccess(user.userId, eventId, "view"))?.kind === "not_found") return notFoundResponse("Event not found")

    const parsed = linesSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const held = await reserveTickets({ eventId, buyerId: user.userId, lines: toReserveLines(parsed.data.lines) })
    if (!held.ok) return refusalResponse(held.reason)

    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: held.orderId }, select: { total_minor: true, currency: true, hold_expires_at: true } })
    let orderRef: string
    try {
      orderRef = (await createTicketOrder({ orderId: held.orderId, amountMinor: order.total_minor, currency: order.currency })).id
    } catch (error) {
      await cancelHold(held.orderId)
      logger.error("Razorpay order for a ticket hold failed; the hold was given back", { orderId: held.orderId, error: error instanceof Error ? error.message : String(error) })
      return errorResponse("Payments are not available right now", 503)
    }
    await db.ticket_orders.update({ where: { id: held.orderId }, data: { provider_order_ref: orderRef } })

    return successResponse(
      {
        orderId: held.orderId,
        status: "pending" as const,
        totalMinor: order.total_minor,
        currency: order.currency,
        holdExpiresAt: order.hold_expires_at.toISOString(),
        payUrl: payUrlFor(held.orderId, user.userId),
      },
      201
    )
  } catch (error) {
    logger.error("Ticket order error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to hold the tickets")
  }
}
