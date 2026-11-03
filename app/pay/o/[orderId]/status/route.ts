import { NextResponse, type NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import { db } from "@/lib/db"
import { ticketingOn } from "@/lib/env"
import { networkLimit, rateLimit } from "@/lib/rate-limit"
import { verifyPayToken } from "@/lib/ticket-pay-token"

/**
 * The pay page's own door (SCRUM-1011): the browser has no JWT, only the pay
 * link's token (lib/ticket-pay-token.ts), bound to this order and its buyer.
 *
 * GET  `?t=` — the order's status, for the page to poll while Razorpay's
 *      webhook confirms the payment. It writes nothing: "paid" is the
 *      webhook's word only.
 * POST `?t=` — a new checkout attempt has started: the last one's failure
 *      (`paymentFailed`, contract §8.2) is cleared.
 *
 * A token that is tampered with, expired or for another order is a 401;
 * nothing in the answer says which.
 */

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
const fail = (status: number) => NextResponse.json({ error: status === 401 ? "unauthorized" : "not_found" }, { status, headers: NO_STORE })

async function authorised(req: NextRequest, orderId: string) {
  if (!ticketingOn() || !isUuid(orderId)) return { error: fail(404) }
  const limited = await rateLimit(req, networkLimit("pay-status", 60_000, 120))
  if (limited) return { error: limited }
  const order = await db.ticket_orders.findUnique({
    where: { id: orderId },
    select: { buyer_id: true, status: true, payment_failed_at: true, hold_expires_at: true },
  })
  if (!order) return { error: fail(404) }
  if (verifyPayToken(req.nextUrl.searchParams.get("t"), orderId, order.buyer_id) !== "ok") return { error: fail(401) }
  return { order }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  const { order, error } = await authorised(req, orderId)
  if (error) return error
  return NextResponse.json(
    { status: order.status, paymentFailed: order.status === "pending" && order.payment_failed_at !== null, holdExpiresAt: order.hold_expires_at.toISOString() },
    { headers: NO_STORE }
  )
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  const { error } = await authorised(req, orderId)
  if (error) return error
  await db.ticket_orders.updateMany({ where: { id: orderId, status: "pending" }, data: { payment_failed_at: null } })
  return new NextResponse(null, { status: 204, headers: NO_STORE })
}
