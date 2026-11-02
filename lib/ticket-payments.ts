import type { Prisma } from "@prisma/client"

// Relative imports: lib/ticket-reconcile.ts reaches this from server.ts (`build:server`, plain tsc).
import { payoutsConnected } from "./payout-status"
import { lateSeatRefusal } from "./ticket-holds"
import { issueTickets } from "./tickets"

/**
 * A captured ticket payment, applied (SCRUM-1011). The Phase 2 contract in
 * lib/ticket-holds.ts, built:
 *
 * 1. Lock the order (`FOR UPDATE`), then its types in id order: the order
 *    lock first, so it cannot deadlock a reserve (types first, orders
 *    `SKIP LOCKED`) or the sweeper (orders `SKIP LOCKED`, then types).
 * 2. Hold the payment to the order row and nothing else: the amount captured
 *    is `total_minor`, in `currency`. Anything else is refused and logged.
 * 3. A `pending` order: `held -= q`, `sold += q`, `paid`, tickets issued, the
 *    RSVP written, the payout owed, all in this transaction.
 * 4. An `expired` order (paid after its seats went back): re-seated straight
 *    to `sold` only if a hold for it would be granted now — every gate a hold
 *    runs (`lateSeatRefusal`: the buyer's standing and the RSVP's door, the
 *    event still selling, the sale window, minimum age, capacity, the seat
 *    cap) — then as 3. If not, or the order was
 *    `cancelled` (its buyer deleted the account), or the event is no longer on,
 *    the payment is recorded on the order and a full refund is asked for
 *    (`refund_requested_*`): `executeRefund` makes it after the commit, and the
 *    reconcile job retries it. Never tickets that oversell the room.
 * 5. Replays are no-ops: the order already carries this payment's id.
 *
 * Used by the webhook (inside its `payment_events` claim, so a delivery twice
 * is one fulfilment) and by the reconcile job (a webhook that never came).
 * Nothing here calls Razorpay: what must wait for the commit is returned.
 */

export interface CapturedPayment {
  paymentId: string
  /** The Razorpay order (`order_…`) the payment was made against. */
  orderRef: string
  amountMinor: number
  currency: string
  capturedAt: Date
}

interface Settled {
  orderId: string
  eventId: string
  buyerId: string
  orgId: string | null
}

export type SettleOutcome =
  | { kind: "not_ticket" }
  | ({ kind: "duplicate" } & Settled)
  | ({ kind: "refused"; reason: "amount_mismatch" | "second_payment" } & Settled)
  | ({ kind: "paid"; late: boolean; tickets: number } & Settled)
  | ({ kind: "refund_due"; reason: RefundReason } & Settled)

export type RefundReason = "late_payment" | "order_cancelled" | "event_not_on"

/** The payout is held until this long after the event ends: a chargeback comes out of it. */
export const PAYOUT_HOLD_AFTER_EVENT_MS = 3 * 24 * 60 * 60 * 1000

interface LockedOrder {
  id: string
  event_id: string
  buyer_id: string
  status: "pending" | "paid" | "refunded" | "expired" | "cancelled"
  currency: string
  total_minor: number
  service_fee_minor: number
  service_fee_tax_minor: number
  processing_fee_minor: number
  provider_payment_ref: string | null
}

type Line = { ticket_type_id: string; quantity: number }

/** The organizer's share: what the buyer paid, less our fee, its tax and processing (ticket-fees `organizerPayoutMinor`). */
export const organizerShare = (o: Pick<LockedOrder, "total_minor" | "service_fee_minor" | "service_fee_tax_minor" | "processing_fee_minor">) =>
  o.total_minor - o.service_fee_minor - o.service_fee_tax_minor - o.processing_fee_minor

export async function lockOrderByRef(tx: Prisma.TransactionClient, orderRef: string): Promise<LockedOrder | null> {
  const [order] = await tx.$queryRaw<LockedOrder[]>`
    SELECT id::text, event_id::text, buyer_id, status::text AS status, currency, total_minor, service_fee_minor,
           service_fee_tax_minor, processing_fee_minor, provider_payment_ref
      FROM ticket_orders
     WHERE provider = 'razorpay' AND provider_order_ref = ${orderRef}
       FOR UPDATE`
  return order ?? null
}

/**
 * The order's lines, and every type of its event locked in id order: the
 * order a reserve takes them in, so a late payment's gates (which read the
 * whole event, `lateSeatRefusal`) never take a lower id after a higher one.
 */
export async function lockLines(tx: Prisma.TransactionClient, orderId: string) {
  const lines = await tx.ticket_order_lines.findMany({ where: { order_id: orderId }, select: { ticket_type_id: true, quantity: true, event_id: true }, orderBy: { ticket_type_id: "asc" } })
  const types = await tx.$queryRaw<{ id: string; quantity: number; sold: number; held: number }[]>`
    SELECT id::text, quantity, sold, held FROM ticket_types WHERE event_id = ${lines[0]?.event_id ?? null}::uuid ORDER BY id FOR UPDATE`
  return { lines, types: new Map(types.map((t) => [t.id, t])) }
}

/** One statement per move: `held` and `sold` shift by each line's quantity (negative to give seats back). */
export async function moveSeats(tx: Prisma.TransactionClient, lines: Line[], d: { held: -1 | 0 | 1; sold: -1 | 0 | 1 }) {
  await tx.$executeRaw`
    UPDATE ticket_types AS t
       SET held = t.held + ${d.held}::int * v.quantity, sold = t.sold + ${d.sold}::int * v.quantity, updated_at = now()
      FROM unnest(${lines.map((l) => l.ticket_type_id)}::uuid[], ${lines.map((l) => l.quantity)}::int[]) AS v(id, quantity)
     WHERE t.id = v.id`
}

async function context(tx: Prisma.TransactionClient, order: LockedOrder) {
  const [event, buyer] = await Promise.all([
    tx.events.findUnique({
      where: { id: order.event_id },
      select: {
        status: true,
        deleted_at: true,
        end_time: true,
        organizer_org_id: true,
        organizer_org: { select: { razorpay_account_id: true, razorpay_account_status: true } },
      },
    }),
    tx.user.findUnique({ where: { id: order.buyer_id }, select: { deletedAt: true } }),
  ])
  return {
    on: event !== null && event.status === "published" && event.deleted_at === null,
    buyerGone: !buyer || buyer.deletedAt !== null,
    orgId: event?.organizer_org_id ?? null,
    // Only an active linked account is paid; otherwise the payout is recorded as owed to nobody (`no_account`).
    account: event?.organizer_org && payoutsConnected(event.organizer_org) ? event.organizer_org.razorpay_account_id : null,
    endTime: event?.end_time ?? new Date(),
  }
}

export async function settleTicketPayment(tx: Prisma.TransactionClient, p: CapturedPayment, now: Date = new Date()): Promise<SettleOutcome> {
  const order = await lockOrderByRef(tx, p.orderRef)
  if (!order) return { kind: "not_ticket" }
  const ctx = await context(tx, order)
  const settled: Settled = { orderId: order.id, eventId: order.event_id, buyerId: order.buyer_id, orgId: ctx.orgId }

  if (order.provider_payment_ref === p.paymentId) return { kind: "duplicate", ...settled }
  // Razorpay closes an order once paid; a second payment on one is for a person to refund.
  if (order.provider_payment_ref) return { kind: "refused", reason: "second_payment", ...settled }
  if (p.amountMinor !== order.total_minor || p.currency !== order.currency) return { kind: "refused", reason: "amount_mismatch", ...settled }

  const { lines } = await lockLines(tx, order.id)
  const refuseReason = await whyNotSeated(tx, order, lines, ctx, now)
  if (refuseReason) {
    if (order.status === "pending") await moveSeats(tx, lines, { held: -1, sold: 0 })
    await tx.ticket_orders.update({
      where: { id: order.id },
      data: {
        ...(order.status === "pending" ? { status: "cancelled" as const } : {}),
        provider_payment_ref: p.paymentId,
        paid_at: p.capturedAt,
        refund_requested_at: now,
        refund_requested_minor: order.total_minor,
        refund_reason: refuseReason,
      },
    })
    return { kind: "refund_due", reason: refuseReason, ...settled }
  }

  await moveSeats(tx, lines, order.status === "pending" ? { held: -1, sold: 1 } : { held: 0, sold: 1 })
  await tx.ticket_orders.update({ where: { id: order.id }, data: { status: "paid", provider_payment_ref: p.paymentId, paid_at: p.capturedAt } })
  const tickets = await issueTickets(tx, order.id)
  // A paid ticket is "going": rooms, check-in and the counts all read the RSVP.
  await tx.event_rsvps.upsert({
    where: { event_id_user_id: { event_id: order.event_id, user_id: order.buyer_id } },
    create: { event_id: order.event_id, user_id: order.buyer_id, status: "going" },
    update: { status: "going", updated_at: now },
  })
  await owePayout(tx, order, ctx)
  return { kind: "paid", late: order.status !== "pending", tickets: tickets.length, ...settled }
}

async function whyNotSeated(
  tx: Prisma.TransactionClient,
  order: LockedOrder,
  lines: Line[],
  ctx: { on: boolean; buyerGone: boolean },
  now: Date
): Promise<RefundReason | null> {
  if (order.status === "cancelled" || ctx.buyerGone) return "order_cancelled"
  if (order.status === "pending") return ctx.on ? null : "event_not_on"
  // Expired: its seats went back. Seated again only as a new hold would be, under the type locks.
  const refused = await lateSeatRefusal(tx, { eventId: order.event_id, buyerId: order.buyer_id, lines: lines.map((l) => ({ ticketTypeId: l.ticket_type_id, quantity: l.quantity })) }, now)
  return refused ? "late_payment" : null
}

/** The organizer's share, owed to the organisation's linked account; the transfer is made after the commit. */
async function owePayout(tx: Prisma.TransactionClient, order: LockedOrder, ctx: { orgId: string | null; account: string | null; endTime: Date }) {
  const amount = organizerShare(order)
  if (!ctx.orgId || amount < 1) return
  await tx.ticket_payouts.create({
    data: {
      order_id: order.id,
      org_id: ctx.orgId,
      linked_account_ref: ctx.account,
      amount_minor: amount,
      currency: order.currency,
      status: ctx.account ? "pending" : "no_account",
      on_hold_until: new Date(ctx.endTime.getTime() + PAYOUT_HOLD_AFTER_EVENT_MS),
    },
  })
}
