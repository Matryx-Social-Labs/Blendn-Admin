import { Prisma, type user_role } from "@prisma/client"

import { isUuid } from "./api-input"
import { auditInTx } from "./audit-log"
import { db } from "./db"
import { razorpayKeys, ticketingOn } from "./env"
import { logger } from "./logger"
import { actorFor } from "./org-membership"
import { eventPermissionSelect, eventPermissions } from "./rbac"
import { cancelEventHolds } from "./ticket-holds"
import { PAYOUT_GONE } from "./ticket-payments"
import { BUYER_REFUND, BUYER_REFUND_ACTION, buyerRefundRefusal, EVENT_CANCELLED_REFUND, policyRefundDebit, policyRefundMinor, type BuyerRefundRefusal } from "./ticket-refund-policy"
import { executeRefund } from "./ticket-settle"

/**
 * Ticket refunds (SCRUM-1011; the buyer's own, SCRUM-1113).
 *
 * Every entry point only *claims* refunds, under the order's row lock, and
 * then makes them through `executeRefund`: Razorpay is never called inside a
 * transaction, and a call that fails leaves the claim for the reconcile job.
 *
 * Two doors to one claim (`claimPolicyRefund`), the same amount from both:
 *
 * - `refundOrder`, the organizer: `eventPermissions(...).canEdit` on
 *   `actorFor`, so role and memberships are the database's; any time.
 * - `buyerRefund`, the order's buyer: automatic, inside the event's refund
 *   window, re-checked under the locks (`buyerRefundRefusal`).
 *
 * Anyone else reads the order as not found. What comes back, per the organizer
 * agreement (5.4) and the owner's ruling of 2026-11-25:
 *
 * - The full ticket price, always. A booking fee the buyer paid is kept, so
 *   the refund is the organizer's share and its transfer is reversed whole.
 *   Fees the organizer absorbed are charged to them (`org_debit_minor`,
 *   lib/ticket-settle.ts): the share taken back is short by them.
 *   Only while the share is held: once its payout is `releasing` or
 *   `released` (lib/payout-release.ts) it is refused, whoever asks. The
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
  constructor(readonly reason: RefundRefusal | BuyerRefundRefusal) {
    super(reason)
  }
}

type LockedOrder = {
  event_id: string
  buyer_id: string
  status: string
  refund_requested_at: Date | null
  subtotal_minor: number
  total_minor: number
  service_fee_minor: number
  service_fee_tax_minor: number
  processing_fee_minor: number
}

/** Who is asking, decided on the locked order. Throws `Refused`; what it returns is written as the claim's reason and audit row. */
type Door = (tx: Prisma.TransactionClient, order: LockedOrder | undefined, payoutStatus: string | null) => Promise<{ order: LockedOrder; orgId: string | null; userId?: string; action: string; reason: string }>

async function claimPolicyRefund(orderId: string, door: Door): Promise<void> {
  await db.$transaction(async (tx) => {
    // One lock order everywhere (security review 6): the payout row, then its order, as the release job's claim.
    // The payout's status is the only release source: locked, so the release job claims it before us or after.
    const [payout] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM ticket_payouts WHERE order_id = ${orderId}::uuid FOR UPDATE`
    const [locked] = await tx.$queryRaw<LockedOrder[]>`
      SELECT event_id::text, buyer_id, status::text AS status, refund_requested_at, subtotal_minor, total_minor, service_fee_minor, service_fee_tax_minor, processing_fee_minor
        FROM ticket_orders WHERE id = ${orderId}::uuid FOR UPDATE`
    const { order, orgId, userId, action, reason } = await door(tx, locked, payout?.status ?? null)
    if (order.status !== "paid") throw new Refused("not_paid")
    if (payout && PAYOUT_GONE.has(payout.status)) throw new Refused("payout_released")
    const amount = policyRefundMinor(order)
    await tx.ticket_orders.update({ where: { id: orderId }, data: { refund_requested_at: new Date(), refund_requested_minor: amount, refund_reason: reason } })
    if (orgId) {
      await auditInTx(tx, {
        ...(userId ? { userId } : {}),
        action,
        resource: "ticket_order",
        resourceId: orderId,
        orgId,
        details: { amountMinor: amount, chargedFeesMinor: policyRefundDebit(order), reason },
      })
    }
  }, TX)
}

/** Make a claimed refund now. False: Razorpay failed, and the reconcile job retries the claim. */
async function makeNow(orderId: string): Promise<boolean> {
  try {
    await executeRefund(orderId)
    return true
  } catch (error) {
    logger.error("Ticket refund failed at Razorpay; the reconcile job retries it", { orderId, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

/** A buyer's order refunded by the organizer: the ticket price, booking fee kept. */
export async function refundOrder(orderId: string, user: Actor, reason: string): Promise<{ ok: true } | { ok: false; reason: RefundRefusal }> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!razorpayKeys()) return { ok: false, reason: "payments_off" }
  if (!isUuid(orderId)) return { ok: false, reason: "not_found" }
  const why = (typeof reason === "string" ? reason.trim() : "").slice(0, REASON_MAX) || "organizer"

  try {
    await claimPolicyRefund(orderId, async (tx, order) => {
      const event = order ? await canEditEvent(tx, order.event_id, user) : null
      if (!order || !event) throw new Refused("not_found")
      if (order.refund_requested_at) throw new Refused("already_refunding")
      return { order, orgId: event.organizer_org_id, userId: user.id, action: "ticket_order.refund", reason: why }
    })
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason as RefundRefusal }
    throw error
  }
  return (await makeNow(orderId)) ? { ok: true } : { ok: false, reason: "retrying" }
}

export type BuyerRefundAnswer = { ok: true } | { ok: false; reason: BuyerRefundRefusal | "ticketing_off" | "payments_off" | "not_found" }

/**
 * A buyer's own refund, automatic inside the event's refund window (owner
 * 2026-11-25): no host step. The buyer only; anyone else reads not found.
 * Asking again is the same yes and claims nothing. A Razorpay failure is still
 * a yes: the claim stands and the reconcile job makes it.
 *
 * The audit row names nobody (no `userId`, which the platform's own rows also
 * lack): it is the organization's to read, and hosts never learn who a buyer
 * is. Who asked is the order's `buyer_id`.
 */
export async function buyerRefund(orderId: string, buyerId: string, now: Date = new Date()): Promise<BuyerRefundAnswer> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!isUuid(orderId)) return { ok: false, reason: "not_found" }
  if (!razorpayKeys()) return { ok: false, reason: "payments_off" }

  try {
    await claimPolicyRefund(orderId, async (tx, order, payoutStatus) => {
      if (!order || order.buyer_id !== buyerId) throw new Refused("not_found")
      if (order.refund_requested_at) throw new Refused("already_refunding")
      const event = await tx.events.findUniqueOrThrow({
        where: { id: order.event_id },
        select: { status: true, deleted_at: true, refund_policy: true, start_time: true, organizer_org_id: true },
      })
      // Read under the order's lock, which a door scan shares (`redeemTicket`).
      const ticketUsed = (await tx.tickets.count({ where: { order_id: orderId, redeemed_at: { not: null } } })) > 0
      const refused = buyerRefundRefusal({ status: order.status, payoutStatus, ticketUsed, event }, now)
      if (refused) throw new Refused(refused)
      return { order, orgId: event.organizer_org_id, action: BUYER_REFUND_ACTION, reason: BUYER_REFUND }
    })
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    return error.reason === "already_refunding" ? { ok: true } : { ok: false, reason: error.reason as BuyerRefundRefusal | "not_found" }
  }
  await makeNow(orderId)
  return { ok: true }
}

export type CancelRefusal = "ticketing_off" | "payments_off" | "not_found" | "event_not_cancelled"

/**
 * Every paid order of a cancelled event refunded in full, except one whose
 * payout was already released (or is being): that money has left us, so it is
 * flagged for manual recovery (`ticket_order.cancel_refund_manual`) instead. The event must be
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
    // One lock order everywhere (security review 6): the event's payout rows, then its orders, each in id order.
    const payouts = await tx.$queryRaw<{ order_id: string; status: string }[]>`
      SELECT p.order_id::text, p.status::text AS status FROM ticket_payouts p JOIN ticket_orders o ON o.id = p.order_id
       WHERE o.event_id = ${eventId}::uuid ORDER BY p.order_id FOR UPDATE OF p`
    await tx.$queryRaw`SELECT id FROM ticket_orders WHERE event_id = ${eventId}::uuid AND status = 'paid' ORDER BY id FOR UPDATE`
    // Money we no longer hold: the organizer's share was released (or is being). Not refunded from here; flagged for a person.
    const gone = payouts.filter((p) => PAYOUT_GONE.has(p.status)).map((p) => p.order_id)
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE ticket_orders
         SET refund_requested_at = now(), refund_requested_minor = total_minor, refund_reason = ${EVENT_CANCELLED_REFUND}, updated_at = now()
       WHERE event_id = ${eventId}::uuid AND status = 'paid' AND refund_requested_at IS NULL AND NOT (id::text = ANY(${gone}::text[]))
      RETURNING id::text`
    if (event.organizer_org_id) {
      await auditInTx(tx, { userId: user.id, action: "ticketing.cancel_refund_all", resource: "event", resourceId: eventId, orgId: event.organizer_org_id, details: { orders: rows.length, manual: gone.length } })
      for (const orderId of gone) {
        await auditInTx(tx, {
          userId: user.id,
          action: "ticket_order.cancel_refund_manual",
          resource: "ticket_order",
          resourceId: orderId,
          orgId: event.organizer_org_id,
          details: { eventId, why: "payout already released to the organizer: refund the buyer and recover the share by hand (terms 4.4, 5.5)" },
        })
      }
    }
    if (gone.length) logger.error("Cancelled event has payouts already released: refunds need a person", { eventId, orders: gone })
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
