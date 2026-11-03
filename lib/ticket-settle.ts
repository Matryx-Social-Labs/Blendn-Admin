import type { Prisma } from "@prisma/client"

// Relative imports: reached from server.ts through lib/ticket-reconcile.ts (`build:server`, plain tsc).
import { db } from "./db"
import { sendEmail, ticketOrderEmail } from "./email"
import { logger } from "./logger"
import { sendPushNotification } from "./push-notifications"
import { createTransfer, paymentRefunds, paymentTransfers, refundPayment, reverseTransfer } from "./razorpay"
import { lockLines, moveSeats, type SettleOutcome } from "./ticket-payments"

/**
 * What a ticket payment or refund does after its transaction commits
 * (SCRUM-1011): the Razorpay calls (Route transfer, refund, reversal) and the
 * buyer's push and email. Never inside the transaction: a slow Razorpay must
 * not hold the order's lock, and a call that fails must not roll back a
 * payment we have recorded.
 *
 * Every call here is safe to repeat, because the reconcile job repeats it:
 *
 * - a transfer asks Razorpay for the payment's transfers first, and adopts one
 *   to the same account for the same amount instead of making a second;
 * - a refund asks for the payment's refunds first, and refunds only what is
 *   still owed;
 * - each state change is a conditional update on the row's current status.
 */

const TX = { maxWait: 10_000, timeout: 15_000 }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/* ------------------------------------------------------------------------ */
/* Payouts                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Make the Route transfer a `pending` payout owes. Returns the transfer id, or
 * null when nothing is owed. The transfer is held at Razorpay indefinitely
 * (`createTransfer`); only the release job releases it (lib/payout-release.ts).
 */
export async function createPayoutTransfer(orderId: string): Promise<string | null> {
  const payout = await db.ticket_payouts.findUnique({
    where: { order_id: orderId },
    select: { status: true, linked_account_ref: true, amount_minor: true, currency: true, order: { select: { provider_payment_ref: true } } },
  })
  const paymentId = payout?.order.provider_payment_ref
  if (!payout || payout.status !== "pending" || !payout.linked_account_ref || !paymentId) return null
  const account = payout.linked_account_ref

  const existing = (await paymentTransfers(paymentId)).find((t) => t.recipient === account && t.amount === payout.amount_minor)
  const transfer = existing ?? (await createTransfer({ paymentId, account, amountMinor: payout.amount_minor, currency: payout.currency, orderId }))

  const { count } = await db.ticket_payouts.updateMany({
    where: { order_id: orderId, status: "pending" },
    data: { status: "on_hold", provider_transfer_ref: transfer.id },
  })
  if (count === 0) {
    // Refunded while the transfer was being made: the refund marked it reversed, so take this one straight back.
    await reverseTransfer(transfer.id, payout.amount_minor)
    await db.ticket_payouts.update({ where: { order_id: orderId }, data: { provider_transfer_ref: transfer.id, reversed_minor: payout.amount_minor } })
    logger.warn("A ticket payout was transferred after its order was refunded; reversed", { orderId, transferId: transfer.id })
  }
  return transfer.id
}

/** Take back a refunded order's transfer, from the organizer's held payout. */
export async function reversePayout(orderId: string): Promise<void> {
  const payout = await db.ticket_payouts.findUnique({
    where: { order_id: orderId },
    select: { status: true, provider_transfer_ref: true, amount_minor: true, reversed_minor: true, order: { select: { refund_reason: true, processing_fee_minor: true } } },
  })
  if (!payout || payout.status !== "on_hold" || !payout.provider_transfer_ref) return
  const amount = payout.amount_minor - payout.reversed_minor
  if (amount > 0) await reverseTransfer(payout.provider_transfer_ref, amount)
  await db.ticket_payouts.updateMany({
    where: { order_id: orderId, status: "on_hold" },
    data: {
      status: "reversed",
      reversed_minor: payout.amount_minor,
      // The organizer cancelled: Razorpay keeps its processing, and the agreement charges it to them.
      org_debit_minor: payout.order.refund_reason === "event_cancelled" ? payout.order.processing_fee_minor : 0,
    },
  })
}

/* ------------------------------------------------------------------------ */
/* Refunds                                                                   */
/* ------------------------------------------------------------------------ */

export interface ConfirmedRefund {
  refundRef: string
  amountMinor: number
}

/**
 * Record Razorpay's confirmed refund of an order, once. A paid order gives its
 * seats back and its buyer's RSVP goes unless another paid order holds one; its
 * tickets stay as rows, and the door refuses them (`redeemTicket` admits only
 * a paid order's). A payout not yet transferred is closed here; one on hold is
 * reversed after the commit (`reversePayout`).
 */
export async function finishRefund(tx: Prisma.TransactionClient, orderId: string, refund: ConfirmedRefund, now: Date = new Date()): Promise<boolean> {
  const [order] = await tx.$queryRaw<{ status: string; event_id: string; buyer_id: string }[]>`
    SELECT status::text AS status, event_id::text, buyer_id FROM ticket_orders WHERE id = ${orderId}::uuid FOR UPDATE`
  if (!order || order.status === "refunded") return false

  if (order.status === "paid") {
    const { lines } = await lockLines(tx, orderId)
    await moveSeats(tx, lines, { held: 0, sold: -1 })
    const stillHolds = await tx.ticket_orders.count({
      where: { event_id: order.event_id, buyer_id: order.buyer_id, status: "paid", id: { not: orderId } },
    })
    if (stillHolds === 0) await tx.event_rsvps.deleteMany({ where: { event_id: order.event_id, user_id: order.buyer_id } })
  }
  await tx.ticket_orders.update({
    where: { id: orderId },
    data: { status: "refunded", refunded_minor: refund.amountMinor, provider_refund_ref: refund.refundRef, refunded_at: now },
  })
  // Never transferred: nothing to take back, and the retry must not make it now.
  await tx.ticket_payouts.updateMany({ where: { order_id: orderId, status: { in: ["pending", "no_account"] } }, data: { status: "reversed" } })
  return true
}

/**
 * Make the refund an order has asked for (`refund_requested_minor`), then
 * record it and reverse the payout. Razorpay's refunds of the payment are read
 * first and only what is still owed is refunded, so a retry after a crash
 * between Razorpay's answer and our commit refunds nothing twice.
 */
export async function executeRefund(orderId: string): Promise<boolean> {
  const order = await db.ticket_orders.findUnique({
    where: { id: orderId },
    select: { status: true, provider_payment_ref: true, refund_requested_minor: true },
  })
  if (!order || order.status === "refunded" || !order.provider_payment_ref || !order.refund_requested_minor) return false
  const paymentId = order.provider_payment_ref
  const asked = order.refund_requested_minor

  const done = (await paymentRefunds(paymentId)).filter((r) => r.status !== "failed")
  const already = done.reduce((sum, r) => sum + r.amount, 0)
  const refund = already >= asked && done.length > 0 ? done[done.length - 1] : await refundPayment({ paymentId, amountMinor: asked - already, orderId })

  const finished = await db.$transaction((tx) => finishRefund(tx, orderId, { refundRef: refund.id, amountMinor: asked }), TX)
  await afterRefund(orderId, finished)
  return finished
}

/** Refunds we make without anyone asking: the buyer was told when it was decided (`notifyRefundDue`). */
const AUTOMATIC_REFUNDS = new Set(["late_payment", "order_cancelled", "event_not_on"])

/**
 * After a refund is recorded, by whichever of `executeRefund` and the
 * `refund.processed` webhook got there first: the payout is reversed (a
 * no-op once it is), and the buyer told once, by the one that recorded it.
 */
export async function afterRefund(orderId: string, recordedHere: boolean): Promise<void> {
  await reversePayout(orderId)
  if (!recordedHere) return
  const order = await db.ticket_orders.findUnique({ where: { id: orderId }, select: { refund_reason: true } })
  if (!AUTOMATIC_REFUNDS.has(order?.refund_reason ?? "")) await notifyRefunded(orderId)
}

/* ------------------------------------------------------------------------ */
/* After a payment                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The follow-ups of a settled payment, for the caller to run after its commit.
 * Each catches and logs its own failure: the reconcile job retries the money,
 * and a missed push is a missed push.
 */
export function afterSettle(outcome: SettleOutcome): Array<() => Promise<unknown>> {
  if (outcome.kind === "paid") {
    const { orderId } = outcome
    return [
      () => createPayoutTransfer(orderId).catch((e) => logger.error("Ticket payout transfer failed; the reconcile job retries it", { orderId, error: message(e) })),
      () => notifyPaid(orderId).catch((e) => logger.warn("Ticket confirmation not sent", { orderId, error: message(e) })),
    ]
  }
  if (outcome.kind === "refund_due") {
    const { orderId } = outcome
    return [
      () => notifyRefundDue(orderId).catch((e) => logger.warn("Late-payment notice not sent", { orderId, error: message(e) })),
      () => executeRefund(orderId).catch((e) => logger.error("Ticket refund failed; the reconcile job retries it", { orderId, error: message(e) })),
    ]
  }
  return []
}

async function buyerAndEvent(orderId: string) {
  return db.ticket_orders.findUnique({
    where: { id: orderId },
    select: {
      buyer_id: true,
      event_id: true,
      total_minor: true,
      currency: true,
      _count: { select: { tickets: true } },
      buyer: { select: { email: true, deletedAt: true } },
      event: { select: { title: true } },
    },
  })
}

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(minor / 100)

async function tell(orderId: string, push: (o: NonNullable<Awaited<ReturnType<typeof buyerAndEvent>>>) => { title: string; body: string; subject: string; heading: string; paragraphs: string[] }) {
  const o = await buyerAndEvent(orderId)
  if (!o) return
  const say = push(o)
  await sendPushNotification({ userId: o.buyer_id, title: say.title, body: say.body, data: { type: "event_update", eventId: o.event_id, orderId } })
  if (o.buyer.email && !o.buyer.deletedAt) {
    await sendEmail({ to: o.buyer.email, ...ticketOrderEmail({ subject: say.subject, heading: say.heading, paragraphs: say.paragraphs, orderId }) })
  }
}

export const notifyPaid = (orderId: string) =>
  tell(orderId, (o) => {
    const n = o._count.tickets
    const tickets = `${n} ticket${n === 1 ? "" : "s"}`
    return {
      title: o.event.title,
      body: `You’re in. Your ${tickets} ${n === 1 ? "is" : "are"} in Blend’n, ready for the door.`,
      subject: `Your tickets for ${o.event.title}`,
      heading: "You’re in",
      paragraphs: [`Your ${tickets} for ${o.event.title} ${n === 1 ? "is" : "are"} in the Blend’n app. Show the pass at the door; it works without signal.`, `Paid: ${money(o.total_minor, o.currency)}.`],
    }
  })

const notifyRefundDue = (orderId: string) =>
  tell(orderId, (o) => ({
    title: o.event.title,
    body: "Your payment came in after your tickets were released. It’s being refunded in full.",
    subject: `Your payment for ${o.event.title} is being refunded`,
    heading: "Your payment is coming back",
    paragraphs: [
      `Your payment for ${o.event.title} reached us after your hold had ended and the tickets were no longer available, so no tickets were issued.`,
      `We are refunding all of it, ${money(o.total_minor, o.currency)}. Your bank usually shows it within 5–7 working days.`,
    ],
  }))

const notifyRefunded = (orderId: string) =>
  tell(orderId, (o) => ({
    title: o.event.title,
    body: "Your ticket order was refunded.",
    subject: `Refund for ${o.event.title}`,
    heading: "Your order was refunded",
    paragraphs: [`Your ticket order for ${o.event.title} was refunded. Your bank usually shows it within 5–7 working days.`],
  }))
