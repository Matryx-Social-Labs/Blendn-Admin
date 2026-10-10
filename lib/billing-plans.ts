/**
 * What the dashboard sells, at what price. The one place a price lives.
 *
 * Read by the Plan page (what to show), `scripts/razorpay-plans.ts` (what to
 * create at Razorpay), the checkout actions (what to charge) and the webhook
 * (what a payment must have been for). A price changed here changes all four.
 *
 * ## GST
 *
 * The list prices are the audit's (plan v2 §9.1b): ₹1,999 a month, ₹19,990 a
 * year, ₹499 an Event Pass; Venue Pro ₹2,999 a month per venue, or ₹29,990 a
 * year (two months free, audit §6.2); all before 18% GST. India shows consumer prices
 * with tax in, and the plan says to (₹2,359 / ₹589), so what Razorpay charges
 * is the GST-inclusive figure rounded to the rupee — the number on the card is
 * the number on the statement. The invoice splits it back out; issuing it with
 * the right GSTIN is Razorpay Invoices' job, configured by the owner.
 *
 * Pure and client-safe: no database, no secrets.
 */

export const GST_RATE_PERCENT = 18

export type BillingPlanKey =
  | "analytics_monthly"
  | "analytics_yearly"
  | "event_pass"
  | "venue_pro_monthly"
  | "venue_pro_yearly"

export interface BillingPlan {
  key: BillingPlanKey
  /** The entitlement it buys: an organisation's, or (`venue_pro`) one venue's. */
  product: "analytics" | "event_pass" | "venue_pro"
  /** A Razorpay Plan + Subscription, or a one-off Order. */
  kind: "subscription" | "order"
  /** Razorpay's period words, for a subscription. */
  period?: "monthly" | "yearly"
  /** Cycles a subscription runs before Razorpay ends it: ten years either way. */
  totalCount?: number
  label: string
  /** The list price before GST, in whole rupees. */
  listRupees: number
}

export const BILLING_PLANS: Record<BillingPlanKey, BillingPlan> = {
  analytics_monthly: {
    key: "analytics_monthly",
    product: "analytics",
    kind: "subscription",
    period: "monthly",
    totalCount: 120,
    label: "Analytics, monthly",
    listRupees: 1_999,
  },
  analytics_yearly: {
    key: "analytics_yearly",
    product: "analytics",
    kind: "subscription",
    period: "yearly",
    totalCount: 10,
    label: "Analytics, yearly",
    listRupees: 19_990,
  },
  event_pass: {
    key: "event_pass",
    product: "event_pass",
    kind: "order",
    label: "Event Pass",
    listRupees: 499,
  },
  venue_pro_monthly: {
    key: "venue_pro_monthly",
    product: "venue_pro",
    kind: "subscription",
    period: "monthly",
    totalCount: 120,
    label: "Venue Pro, monthly",
    listRupees: 2_999,
  },
  venue_pro_yearly: {
    key: "venue_pro_yearly",
    product: "venue_pro",
    kind: "subscription",
    period: "yearly",
    totalCount: 10,
    label: "Venue Pro, yearly",
    listRupees: 29_990,
  },
}

export function isBillingPlanKey(key: string): key is BillingPlanKey {
  return Object.prototype.hasOwnProperty.call(BILLING_PLANS, key)
}

/** The price with GST, rounded to the rupee: what is shown and what is charged. */
export function grossRupees(plan: BillingPlan): number {
  return Math.round((plan.listRupees * (100 + GST_RATE_PERCENT)) / 100)
}

/** What Razorpay must charge, in paise. The webhook holds every payment to this. */
export function chargeMinor(plan: BillingPlan): number {
  return grossRupees(plan) * 100
}

/** "₹2,359" — Indian grouping, no paise (every price here is whole rupees). */
export function rupees(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount)
}

/** The card's small print: "₹1,999 + ₹360 GST". */
export function gstSplit(plan: BillingPlan): string {
  const gross = grossRupees(plan)
  return `${rupees(plan.listRupees)} + ${rupees(gross - plan.listRupees)} GST`
}
