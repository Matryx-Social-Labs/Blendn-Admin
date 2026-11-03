import { Prisma, type user_role } from "@prisma/client"

import { isUuid } from "./api-input"
import { auditInTx } from "./audit-log"
import { db } from "./db"
import { razorpayKeys, ticketingOn } from "./env"
import { logger } from "./logger"
import { actorFor } from "./org-membership"
import { eventPermissionSelect, eventPermissions } from "./rbac"
import { cancelEventHolds } from "./ticket-holds"
import { organizerShare, PAYOUT_GONE } from "./ticket-payments"
import { executeRefund } from "./ticket-settle"

/**
 * Organizer refunds (SCRUM-1011; the dashboard's button is Phase 4).
 *
 * Both entry points only *claim* refunds, under the order's row lock, and
 * then make them through `executeRefund`: Razorpay is never called inside a
 * transaction, and a call that fails leaves the claim for the reconcile job.
 * Authorization is the event's organisation (`eventPermissions(...).canEdit`
 * on `actorFor`, so role and memberships are the database's); anyone else
 * reads the order as not found.
 *
 * What comes back, per the organizer agreement (ticketing-business-model.md):
 *
 * - `refundOrder`, a buyer's request granted: the ticket price. The booking
 *   fee is kept, so the refund is the organizer's share and the share's
 *   transfer is reversed whole: we and they each end where they started.
 *   Only while the share is held: once its payout is `releasing` or
 *   `released` (lib/payout-release.ts) it is refused, whoever calls it. The
 *   payout row is locked, so a refund and a release never both win.
 * - `cancelEventRefundAll`, the organizer cancelled: everything the buyer
 *   paid, booking fee included. We refund our fee; Razorpay keeps its
 *   processing, which is charged to the organisation (`org_debit_minor`).
 */

const TX = { maxWait: 10_000, timeout: 15_000 }
const REASON_MAX = 200
/** Refunds made inline by a cancellation; the rest are the reconcile job's, a batch a pass. */
const INLINE_REFUNDS = 100

type Actor = { id: string; role: user_role }

export type RefundRefusal = "ticketing_off" | "payments_off" | "not_found" | "not_paid" | "already_refunding" | "retrying" | "payout_released"

async function canEditEvent(tx: Prisma.TransactionClient, eventId: string, user: Actor) {
  const event = await tx.events.findUnique({ where: { id: eventId }, select: { ...eventPermissionSelect, status: true } })
  if (!event || !eventPermissions(await actorFor(user), event).canEdit) return null
  return event
}

class Refused extends Error {
  constructor(readonly reason: RefundRefusal) {
    super(reason)
  }
}

/** A buyer's order refunded by the organizer: the ticket price, booking fee kept. */
export async function refundOrder(orderId: string, user: Actor, reason: string): Promise<{ ok: true } | { ok: false; reason: RefundRefusal }> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!razorpayKeys()) return { ok: false, reason: "payments_off" }
  if (!isUuid(orderId)) return { ok: false, reason: "not_found" }
  const why = (typeof reason === "string" ? reason.trim() : "").slice(0, REASON_MAX) || "organizer"

  try {
    await db.$transaction(async (tx) => {
      const [order] = await tx.$queryRaw<
        { event_id: string; status: string; refund_requested_at: Date | null; total_minor: number; service_fee_minor: number; service_fee_tax_minor: number; processing_fee_minor: number }[]
      >`SELECT event_id::text, status::text AS status, refund_requested_at, total_minor, service_fee_minor, service_fee_tax_minor, processing_fee_minor
          FROM ticket_orders WHERE id = ${orderId}::uuid FOR UPDATE`
      const event = order ? await canEditEvent(tx, order.event_id, user) : null
      if (!order || !event) throw new Refused("not_found")
      if (order.refund_requested_at) throw new Refused("already_refunding")
      if (order.status !== "paid") throw new Refused("not_paid")
      // The payout's status is the only source (SCRUM-1014): locked, so the release job claims it before us or after.
      const [payout] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM ticket_payouts WHERE order_id = ${orderId}::uuid FOR UPDATE`
      if (payout && PAYOUT_GONE.has(payout.status)) throw new Refused("payout_released")
      const amount = organizerShare(order)
      await tx.ticket_orders.update({ where: { id: orderId }, data: { refund_requested_at: new Date(), refund_requested_minor: amount, refund_reason: why } })
      if (event.organizer_org_id) {
        await auditInTx(tx, {
          userId: user.id,
          action: "ticket_order.refund",
          resource: "ticket_order",
          resourceId: orderId,
          orgId: event.organizer_org_id,
          details: { amountMinor: amount, reason: why },
        })
      }
    }, TX)
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason }
    throw error
  }

  try {
    await executeRefund(orderId)
    return { ok: true }
  } catch (error) {
    logger.error("Ticket refund failed at Razorpay; the reconcile job retries it", { orderId, error: error instanceof Error ? error.message : String(error) })
    return { ok: false, reason: "retrying" }
  }
}

export type CancelRefusal = "ticketing_off" | "payments_off" | "not_found" | "event_not_cancelled"

/**
 * Every paid order of a cancelled event refunded in full. The event must be
 * cancelled first (no new order can be held for it then); its open holds are
 * given back. Safe to call again: an order already claimed is not claimed twice.
 */
export async function cancelEventRefundAll(
  eventId: string,
  user: Actor
): Promise<{ ok: true; refunded: number; failed: number; queued: number } | { ok: false; reason: CancelRefusal }> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!razorpayKeys()) return { ok: false, reason: "payments_off" }
  if (!isUuid(eventId)) return { ok: false, reason: "not_found" }

  const claimed = await db.$transaction(async (tx) => {
    const event = await canEditEvent(tx, eventId, user)
    if (!event) return "not_found" as const
    if (event.status !== "cancelled") return "event_not_cancelled" as const
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE ticket_orders
         SET refund_requested_at = now(), refund_requested_minor = total_minor, refund_reason = 'event_cancelled', updated_at = now()
       WHERE event_id = ${eventId}::uuid AND status = 'paid' AND refund_requested_at IS NULL
      RETURNING id::text`
    if (event.organizer_org_id) {
      await auditInTx(tx, { userId: user.id, action: "ticketing.cancel_refund_all", resource: "event", resourceId: eventId, orgId: event.organizer_org_id, details: { orders: rows.length } })
    }
    return rows.map((r) => r.id)
  }, TX)
  if (!Array.isArray(claimed)) return { ok: false, reason: claimed }

  await cancelEventHolds(eventId)
  let refunded = 0
  let failed = 0
  for (const orderId of claimed.slice(0, INLINE_REFUNDS)) {
    try {
      if (await executeRefund(orderId)) refunded++
    } catch (error) {
      failed++
      logger.error("Ticket refund failed at Razorpay; the reconcile job retries it", { orderId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: true, refunded, failed, queued: Math.max(0, claimed.length - INLINE_REFUNDS) }
}

/**
 * A cancellation's refunds, from every door that cancels an event (the
 * dashboard and mobile PATCH routes, an admin's status move; SCRUM-1014).
 * After the cancel has committed, and never thrown: a refund Razorpay could
 * not make now is claimed and the reconcile job retries it, and a cancelled
 * event must not read as a failed edit. A free event claims nothing.
 */
export async function refundAllOnCancel(eventId: string, user: Actor): Promise<void> {
  if (!ticketingOn()) return
  try {
    const result = await cancelEventRefundAll(eventId, user)
    if (!result.ok && result.reason !== "ticketing_off") logger.error("Cancelled event's ticket refunds not claimed", { eventId, reason: result.reason })
  } catch (error) {
    logger.error("Cancelled event's ticket refunds failed", { eventId, error: error instanceof Error ? error.message : String(error) })
  }
}
