/**
 * Where a Blendn+ subscription stands, said only from what the store told us
 * (SV, WP6): the latest RevenueCat delivery about that purchase, and the clock.
 * Never a guess: a state the data does not show is `null`, and the route then
 * omits the field.
 */

export type PlusState = "active" | "cancelled" | "grace" | "hold" | "paused" | "expired" | "refunded"
export type PlusGrant = "trial" | "referral"

/** The fields of a stored RevenueCat delivery this reads. */
export interface StoreDelivery {
  type: string
  cancelReason: string | null
  graceExpiresAtMs: number | null
}

/** The same refund reasons `lib/revenuecat-webhook.ts` ends an entitlement for. */
const REFUND_REASONS = new Set(["CUSTOMER_SUPPORT", "DEVELOPER_INITIATED"])

/**
 * `latest` is the newest processed delivery for the purchase, null when there
 * is none (a row the webhook did not write has no state to report). `live` is
 * whether the entitlement row grants access now.
 *
 *   CANCELLATION, a refund reason      refunded
 *   CANCELLATION, any other            cancelled (auto-renew is off; access runs to expiresAt)
 *   BILLING_ISSUE, grace still ahead   grace
 *   BILLING_ISSUE, none, Google, not live   hold (Google's account hold carries no grace period)
 *   SUBSCRIPTION_PAUSED                paused
 *   EXPIRATION                         expired
 *   a purchase, renewal, uncancel or refund reversal   active if live, else expired
 *   anything else                      null: not said
 */
export function plusStateFrom(
  latest: StoreDelivery | null,
  live: boolean,
  source: "apple" | "google",
  now: Date
): PlusState | null {
  if (!latest) return null
  switch (latest.type) {
    case "CANCELLATION":
      return REFUND_REASONS.has(latest.cancelReason ?? "") ? "refunded" : live ? "cancelled" : "expired"
    case "BILLING_ISSUE":
      if (latest.graceExpiresAtMs !== null && latest.graceExpiresAtMs > now.getTime()) return "grace"
      return source === "google" && latest.graceExpiresAtMs === null && !live ? "hold" : null
    case "SUBSCRIPTION_PAUSED":
      return "paused"
    case "EXPIRATION":
      return "expired"
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "REFUND_REVERSED":
    case "SUBSCRIPTION_EXTENDED":
    case "NON_RENEWING_PURCHASE":
      return live ? "active" : "expired"
    default:
      return null
  }
}

/** The grant a row of ours is, from its reference (`lib/plus.ts`: `plus-trial:` / `plus-referral:`). */
export function plusGrantFrom(externalRef: string | null): PlusGrant | null {
  if (externalRef?.startsWith("plus-trial:")) return "trial"
  if (externalRef?.startsWith("plus-referral:")) return "referral"
  return null
}
