// Relative imports: reached from server.ts through lib/background.ts (`build:server`, plain tsc).
import { db } from "./db"
import { razorpayKeys, ticketingOn } from "./env"
import { logger } from "./logger"
import { orderPayments } from "./razorpay"
import { settleTicketPayment } from "./ticket-payments"
import { afterSettle, createPayoutTransfer, executeRefund } from "./ticket-settle"

/**
 * The ticket money nobody confirmed (SCRUM-1011), every five minutes while
 * `TICKETING` is on and Razorpay is configured:
 *
 * 1. **A webhook that never came.** Razorpay orders still unpaid on our side
 *    past their hold (within the last hour) are asked for their payments; a
 *    captured one is settled exactly as the webhook would (lib/ticket-payments.ts),
 *    late-payment rules included.
 * 2. **A refund asked for and not confirmed** (Razorpay failed, or we crashed
 *    after asking): made again; `executeRefund` reads Razorpay's refunds first.
 * 3. **A payout owed and not transferred**: made again; `createPayoutTransfer`
 *    adopts a transfer Razorpay already made.
 *
 * Each item fails alone, logged; the next pass tries again.
 */

export const TICKET_RECONCILE_MS = 5 * 60_000
/** Past this after its hold, an unpaid Razorpay order is not asked about again (Razorpay retries a webhook for a day; Checkout gives up long before). */
const LOOKBACK_MS = 60 * 60_000
/** A refund or a transfer this recent may still be finishing in its own request. */
const SETTLE_AFTER_MS = 2 * 60_000
const BATCH = 50

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function lostPayments(now: Date): Promise<number> {
  const orders = await db.ticket_orders.findMany({
    where: {
      provider_payment_ref: null,
      provider_order_ref: { not: null },
      status: { in: ["pending", "expired", "cancelled"] },
      hold_expires_at: { lte: now, gt: new Date(now.getTime() - LOOKBACK_MS) },
    },
    select: { id: true, provider_order_ref: true },
    orderBy: { hold_expires_at: "asc" },
    take: BATCH,
  })
  let paid = 0
  for (const order of orders) {
    try {
      const captured = (await orderPayments(order.provider_order_ref!)).find((p) => p.status === "captured")
      if (!captured) continue
      const outcome = await db.$transaction(
        (tx) =>
          settleTicketPayment(tx, {
            paymentId: captured.id,
            orderRef: order.provider_order_ref!,
            amountMinor: captured.amount,
            currency: captured.currency,
            capturedAt: new Date(captured.created_at * 1000),
          }),
        { maxWait: 10_000, timeout: 15_000 }
      )
      if (outcome.kind === "refused") logger.error("A ticket payment found by reconcile was refused", { orderId: order.id, reason: outcome.reason })
      for (const step of afterSettle(outcome)) await step()
      if (outcome.kind === "paid") paid++
    } catch (error) {
      logger.error("Ticket payment reconcile failed", { orderId: order.id, error: message(error) })
    }
  }
  return paid
}

async function unconfirmedRefunds(now: Date): Promise<number> {
  const orders = await db.ticket_orders.findMany({
    where: { refund_requested_at: { lte: new Date(now.getTime() - SETTLE_AFTER_MS) }, status: { not: "refunded" } },
    select: { id: true },
    orderBy: { refund_requested_at: "asc" },
    take: BATCH,
  })
  let refunded = 0
  for (const order of orders) {
    try {
      if (await executeRefund(order.id)) refunded++
    } catch (error) {
      logger.error("Ticket refund retry failed", { orderId: order.id, error: message(error) })
    }
  }
  return refunded
}

async function untransferredPayouts(now: Date): Promise<number> {
  const payouts = await db.ticket_payouts.findMany({
    where: { status: "pending", created_at: { lte: new Date(now.getTime() - SETTLE_AFTER_MS) } },
    select: { order_id: true },
    orderBy: { created_at: "asc" },
    take: BATCH,
  })
  let transferred = 0
  for (const payout of payouts) {
    try {
      if (await createPayoutTransfer(payout.order_id)) transferred++
    } catch (error) {
      logger.error("Ticket payout transfer retry failed", { orderId: payout.order_id, error: message(error) })
    }
  }
  return transferred
}

export async function reconcileTicketPayments(now: Date = new Date()): Promise<{ paid: number; refunded: number; transferred: number }> {
  if (!razorpayKeys()) return { paid: 0, refunded: 0, transferred: 0 }
  const paid = await lostPayments(now)
  const refunded = await unconfirmedRefunds(now)
  const transferred = await untransferredPayouts(now)
  return { paid, refunded, transferred }
}

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function run(): Promise<void> {
  try {
    const done = await reconcileTicketPayments()
    if (done.paid || done.refunded || done.transferred) logger.info("Ticket payments reconciled", done)
  } catch (error) {
    logger.error("Ticket reconcile pass failed", { error: message(error) })
  }
}

/** Self-scheduling, like the other sweepers. Off (no timer) unless TICKETING is on at boot. */
export function startTicketReconciler(): void {
  if (timer || !ticketingOn()) return
  stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => void run().finally(schedule), TICKET_RECONCILE_MS)
    timer.unref?.()
  }
  void run().finally(schedule)
}

export function stopTicketReconciler(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}
