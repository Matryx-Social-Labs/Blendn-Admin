import type { ticket_refund_policy } from "@prisma/client"

/**
 * What a refund under the event's policy is worth, and whether its buyer may
 * ask for it now (SCRUM-1113, owner 2026-11-25). One rule for the claim
 * (lib/ticket-refunds.ts, under the locks), the app's offer
 * (lib/ticket-views.ts) and the Sales panel, so none computes its own. Pure,
 * importing nothing of ours: the holds, the payments and the settling read it.
 */

/** `refund_reason` of a refund its buyer asked for. */
export const BUYER_REFUND = "buyer_request"
/** The audit action of one, written with no actor: the row is the organization's to read, and hosts never learn who a buyer is. */
export const BUYER_REFUND_ACTION = "ticket_order.buyer_refund"
/** `refund_reason` of a cancelled event's refunds (`cancelEventRefundAll`). */
export const EVENT_CANCELLED_REFUND = "event_cancelled"

const HOUR_MS = 3_600_000
const WINDOW_MS: Record<ticket_refund_policy, number | null> = { none: null, until_7d: 7 * 24 * HOUR_MS, until_24h: 24 * HOUR_MS }

/** The last moment a buyer may ask, from the event's start as it is now; null under "no refunds". */
export function refundUntil(event: { refund_policy: ticket_refund_policy; start_time: Date }): Date | null {
  const window = WINDOW_MS[event.refund_policy]
  return window === null ? null : new Date(event.start_time.getTime() - window)
}

/** A refund is refused once its payout is being released or released (both doors, the Sales panel). The status is the only source. */
export const PAYOUT_GONE: ReadonlySet<string> = new Set(["releasing", "released"])

type Amounts = { subtotal_minor: number; total_minor: number; service_fee_minor: number; service_fee_tax_minor: number; processing_fee_minor: number }

/** The organizer's share: what the buyer paid, less our fee, its tax and processing (ticket-fees `organizerPayoutMinor`). */
export const organizerShare = (o: Omit<Amounts, "subtotal_minor">): number => o.total_minor - o.service_fee_minor - o.service_fee_tax_minor - o.processing_fee_minor

/** A policy refund, the buyer's or the organizer's: the full ticket price (terms 5.4). */
export const policyRefundMinor = (o: Pick<Amounts, "subtotal_minor">): number => o.subtotal_minor

/** What a policy refund leaves the organization owing: the fees it absorbed, as the share taken back is short by them. Zero when the buyer paid them. */
export const policyRefundDebit = (o: Amounts): number => Math.max(0, policyRefundMinor(o) - organizerShare(o))

export interface BuyerRefundFacts {
  status: string
  payoutStatus: string | null
  ticketUsed: boolean
  event: { status: string; deleted_at: Date | null; refund_policy: ticket_refund_policy; start_time: Date }
}

export type BuyerRefundRefusal = "not_paid" | "payout_released" | "event_canceled" | "refund_policy_none" | "refund_window_closed" | "ticket_used"

/** Why a buyer may not refund this order now, or null. An order already claimed is the caller's to answer. */
export function buyerRefundRefusal(f: BuyerRefundFacts, now: Date): BuyerRefundRefusal | null {
  if (f.status !== "paid") return "not_paid"
  // A canceled event's refund is the full one, booking fee included: never this smaller one in its place.
  if (f.event.status === "cancelled" || f.event.deleted_at) return "event_canceled"
  if (f.payoutStatus && PAYOUT_GONE.has(f.payoutStatus)) return "payout_released"
  const until = refundUntil(f.event)
  if (!until) return "refund_policy_none"
  if (now > until) return "refund_window_closed"
  // Let in on it already (an event moved later reopens the window): the host's to refund.
  return f.ticketUsed ? "ticket_used" : null
}
