/**
 * Why the Razorpay webhook voids a charge, and who the ledger then names as the
 * voider (SCRUM-611).
 *
 * A void made by an admin stores `voided_by`; a void made by the webhook stores
 * NULL there on purpose (nobody pressed anything). The reason it writes is the
 * only thing that says what happened, so the words live here once: the webhook
 * builds them and the ledger reads them back, and the two cannot drift apart.
 */
const REFUND_PREFIX = "Refunded at Razorpay"
const DISPUTE_PREFIX = "Dispute lost at Razorpay"

export const refundVoidReason = (refundId: string | null) => `${REFUND_PREFIX}${refundId ? ` (${refundId})` : ""}`
export const disputeVoidReason = (paymentId: string) => `${DISPUTE_PREFIX} (${paymentId})`

/**
 * The actor for a void the webhook made, or null: an admin's void (`voidedBy`
 * set, even if that admin was since deleted) and a void from before reasons were
 * kept both have no webhook voider.
 */
export function webhookVoider(voidedBy: string | null, reason: string | null): string | null {
  if (voidedBy !== null || !reason) return null
  if (reason.startsWith(REFUND_PREFIX)) return "Razorpay (refund)"
  if (reason.startsWith(DISPUTE_PREFIX)) return "Razorpay (dispute lost)"
  return null
}
