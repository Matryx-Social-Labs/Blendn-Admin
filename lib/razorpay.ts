import { createHmac, timingSafeEqual } from "crypto"
import { z } from "zod"

import { BILLING_PLANS, chargeMinor, type BillingPlan } from "./billing-plans"
import { razorpayKeys } from "./env"

/**
 * Razorpay, over its REST API (plan v2 §9.2).
 *
 * Plain `fetch`, not the `razorpay` npm SDK: billing makes a handful of calls
 * (plans, subscriptions, orders, payment links) and ticketing a few more
 * (orders, refunds, Route transfers and reversals), and one signature is verified. The SDK would add a dependency and its
 * transitive tree to the server bundle for that, and hide the request shape a
 * reviewer needs to see. The webhook signature is ten lines of `crypto`.
 *
 * Every answer is parsed with zod before anything reads it. The keys come from
 * `lib/env.ts` (`razorpayKeys`), which says "off" when they, or the webhook
 * secret, are unset.
 *
 * Not marked `server-only`: `scripts/razorpay-plans.ts` imports it from the
 * command line, where that marker throws. Nothing here is imported by a
 * client component (`checkout.tsx` reaches it only through server actions).
 */

const ROOT = "https://api.razorpay.com"
const API = `${ROOT}/v1`
const TIMEOUT_MS = 15_000
/** A page is 100 plans; an account with more than this many is not ours. */
const MAX_PLAN_PAGES = 5
/** How long a created subscription may wait for its first payment, in Razorpay's clock. */
const SUBSCRIPTION_EXPIRES_AFTER_S = 30 * 60

const HEX_64 = /^[0-9a-f]{64}$/

/**
 * Did Razorpay sign exactly these bytes?
 *
 * The HMAC is over the RAW bytes as received. Parsing and re-serialising first
 * changes whitespace and key order, so a genuine delivery would fail — and a
 * verifier that "fixes" that by comparing against a re-serialised body has
 * stopped checking what was sent. Hex is compared lower-case, so an upper-case
 * signature is the same signature.
 *
 * Constant-time, and the length is compared first because `timingSafeEqual`
 * throws on unequal lengths (as in `lib/leads.ts`). Never throws.
 */
export function verifyWebhookSignature(
  raw: Uint8Array | string,
  signature: string | null | undefined,
  secret: string
): boolean {
  if (!signature || !secret) return false
  const given = signature.trim().toLowerCase()
  if (!HEX_64.test(given)) return false
  const want = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"))
  const got = Buffer.from(given)
  return got.length === want.length && timingSafeEqual(got, want)
}

export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "RazorpayError"
  }
}

const errorBody = z.object({ error: z.object({ description: z.string().optional() }).optional() })

/**
 * Razorpay's edge answers a source IP it blocks with 406, an empty body and
 * `server: awselb/2.0` (SCRUM-607). Name it, or it reads as an outage.
 */
function withoutDescription(res: Response, json: unknown): string {
  if (res.status === 406 && json === null) {
    return `Razorpay’s edge refused this server’s IP (406, empty body, server ${res.headers.get("server") ?? "unknown"}): check the service’s static outbound IPs`
  }
  return `Razorpay answered ${res.status}`
}

async function call<S extends z.ZodType>(
  schema: S,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<z.infer<S>> {
  const keys = razorpayKeys()
  if (!keys) throw new RazorpayError(503, "Razorpay is not configured")
  const auth = Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64")
  // Route linked accounts are v2 only; everything else is v1.
  const res = await fetch(path.startsWith("/v2/") ? `${ROOT}${path}` : `${API}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  })
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    // Razorpay's own sentence when it sent one; never the request, which
    // carries the key in its header.
    const description = errorBody.safeParse(json).data?.error?.description
    throw new RazorpayError(res.status, description ?? withoutDescription(res, json))
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new RazorpayError(502, `Razorpay answered ${path} in an unexpected shape`)
  return parsed.data
}

/* -------------------------------------------------------------------------- */
/* Plans                                                                       */
/* -------------------------------------------------------------------------- */

const planSchema = z.object({
  id: z.string().min(1),
  period: z.string(),
  interval: z.number(),
  item: z.object({ name: z.string(), amount: z.number(), currency: z.string() }),
  // Razorpay answers an empty object with an empty array.
  notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
})
export type RazorpayPlan = z.infer<typeof planSchema>

const planPage = z.object({ items: z.array(planSchema) })

/** Every plan on the account, newest first, up to `MAX_PLAN_PAGES` pages. */
export async function listPlans(): Promise<RazorpayPlan[]> {
  const out: RazorpayPlan[] = []
  for (let page = 0; page < MAX_PLAN_PAGES; page++) {
    const { items } = await call(planPage, "GET", `/plans?count=100&skip=${page * 100}`)
    out.push(...items)
    if (items.length < 100) return out
  }
  return out
}

/**
 * Is this Razorpay plan the one our table describes?
 *
 * Matched on our key AND the price AND the period, so changing a price in
 * `BILLING_PLANS` makes the old plan stop matching: the script then creates a
 * new one and checkout moves to it. Razorpay plans cannot be edited.
 */
export function planMatches(remote: RazorpayPlan, plan: BillingPlan): boolean {
  const notes = Array.isArray(remote.notes) ? {} : (remote.notes ?? {})
  return (
    notes.key === plan.key &&
    remote.period === plan.period &&
    remote.interval === 1 &&
    remote.item.amount === chargeMinor(plan) &&
    remote.item.currency === "INR"
  )
}

export async function createPlan(plan: BillingPlan): Promise<RazorpayPlan> {
  if (plan.kind !== "subscription" || !plan.period) {
    throw new Error(`${plan.key} is a one-off order, not a plan`)
  }
  return call(planSchema, "POST", "/plans", {
    period: plan.period,
    interval: 1,
    item: {
      name: `Blend’n ${plan.label}`,
      amount: chargeMinor(plan),
      currency: "INR",
      description: "Includes 18% GST",
    },
    notes: { key: plan.key },
  })
}

/**
 * The Razorpay plan id for a subscription plan in our table, or null when
 * `scripts/razorpay-plans.ts --apply` has not created it yet. Asked on every
 * checkout start: a click is rare, and a cache would serve a plan the script
 * had just superseded.
 */
export async function planIdFor(plan: BillingPlan): Promise<string | null> {
  return (await listPlans()).find((p) => planMatches(p, plan))?.id ?? null
}

/* -------------------------------------------------------------------------- */
/* Subscriptions and orders                                                    */
/* -------------------------------------------------------------------------- */

const subscriptionSchema = z.object({
  id: z.string().min(1),
  plan_id: z.string(),
  status: z.string(),
  short_url: z.string().optional(),
})
export type RazorpaySubscription = z.infer<typeof subscriptionSchema>

export async function createSubscription(input: {
  planId: string
  totalCount: number
  orgId: string
  /** The venue a Venue Pro subscription is for. */
  venueId?: string | null
  now?: Date
}): Promise<RazorpaySubscription> {
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000)
  return call(subscriptionSchema, "POST", "/subscriptions", {
    plan_id: input.planId,
    total_count: input.totalCount,
    customer_notify: 1,
    // An abandoned checkout stops being payable, so a second one opened later
    // can never become a second mandate (lib/billing-actions.ts resumes a
    // recent one rather than opening another).
    expire_by: now + SUBSCRIPTION_EXPIRES_AFTER_S,
    // For a person reading the Razorpay dashboard. The webhook never reads
    // it: the organisation and venue come from our own `billing_checkouts` row.
    notes: { org_id: input.orgId, ...(input.venueId ? { venue_id: input.venueId } : {}) },
  })
}

/** At the end of the paid cycle when it is running; at once when it is not. */
export async function cancelSubscription(id: string, atCycleEnd: boolean): Promise<RazorpaySubscription> {
  return call(subscriptionSchema, "POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, {
    cancel_at_cycle_end: atCycleEnd ? 1 : 0,
  })
}

const orderSchema = z.object({
  id: z.string().min(1),
  amount: z.number(),
  currency: z.string(),
  status: z.string(),
})
export type RazorpayOrder = z.infer<typeof orderSchema>

export async function createEventPassOrder(input: {
  orgId: string
  eventId: string
  receipt: string
}): Promise<RazorpayOrder> {
  return call(orderSchema, "POST", "/orders", {
    amount: chargeMinor(BILLING_PLANS.event_pass),
    currency: "INR",
    receipt: input.receipt,
    notes: { org_id: input.orgId, event_id: input.eventId },
  })
}

/* -------------------------------------------------------------------------- */
/* Payment Links (sponsor charges, step 17)                                     */
/* -------------------------------------------------------------------------- */

/** How long a sponsor has to pay a link before Razorpay expires it. */
const PAYMENT_LINK_DAYS = 14

/** Razorpay's own hosts for a link a sponsor is sent to pay at. Anything else is not stored or shown. */
const PAY_HOSTS = ["rzp.io", "razorpay.com"]
export function isRazorpayPayUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "https:" && PAY_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
  } catch {
    return false
  }
}

const paymentLinkSchema = z.object({
  id: z.string().min(1),
  short_url: z.string().url().refine(isRazorpayPayUrl, "not a Razorpay payment URL"),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
})
export type RazorpayPaymentLink = z.infer<typeof paymentLinkSchema>

/**
 * A Razorpay Payment Link for one placement charge, in the charge's own
 * amount and currency (INR only). Created WITHOUT notifying anybody: the
 * caller asks Razorpay to email it (`notifyPaymentLink`) only once our record
 * of it is committed, so a link our side refused is never in an inbox (review
 * H4). The sponsor's Placements page carries it too. `notes` are for a person
 * reading the Razorpay dashboard: the webhook resolves the charge from our own
 * `billing_checkouts` row, never from them.
 */
export async function createPaymentLink(input: {
  chargeId: string
  orgId: string
  amountMinor: number
  currency: "INR"
  description: string
  customer: { name: string | null; email: string } | null
  now?: Date
}): Promise<RazorpayPaymentLink> {
  const now = input.now ?? new Date()
  return call(paymentLinkSchema, "POST", "/payment_links", {
    amount: input.amountMinor,
    currency: input.currency,
    accept_partial: false,
    description: input.description.slice(0, 2048),
    // Unique per link, ≤ 40 characters: a second link after the first expired needs its own.
    reference_id: `chg_${input.chargeId.slice(0, 13)}_${now.getTime().toString(36)}`,
    expire_by: Math.floor(now.getTime() / 1000) + PAYMENT_LINK_DAYS * 24 * 60 * 60,
    ...(input.customer
      ? { customer: { email: input.customer.email, ...(input.customer.name ? { name: input.customer.name } : {}) } }
      : {}),
    notify: { email: false, sms: false },
    reminder_enable: true,
    notes: { org_id: input.orgId, charge_id: input.chargeId },
  })
}

/** Ask Razorpay to email the link to its customer, once our record of it is committed. */
export async function notifyPaymentLink(id: string): Promise<void> {
  await call(z.object({}).passthrough(), "POST", `/payment_links/${encodeURIComponent(id)}/notify_by/email`, {})
}

const linkStatusSchema = z.object({ id: z.string().min(1), status: z.string() })

/** Close a link so it can no longer be paid: a void, a hand settlement, an orphan. */
export async function cancelPaymentLink(id: string): Promise<{ id: string; status: string }> {
  return call(linkStatusSchema, "POST", `/payment_links/${encodeURIComponent(id)}/cancel`, {})
}

/** Where Razorpay says a link is now: after a cancel it refused, was it already closed, or paid? */
export async function paymentLinkStatus(id: string): Promise<{ id: string; status: string }> {
  return call(linkStatusSchema, "GET", `/payment_links/${encodeURIComponent(id)}`)
}

/** How long a link lives at Razorpay (`expire_by`), for our own "still open" rule. */
export const PAYMENT_LINK_LIFETIME_MS = PAYMENT_LINK_DAYS * 24 * 60 * 60 * 1000

/** How long Razorpay lets a created subscription wait, for our own "still open" rule. */
export const CREATED_CHECKOUT_LIFETIME_MS = SUBSCRIPTION_EXPIRES_AFTER_S * 1000

/* -------------------------------------------------------------------------- */
/* Tickets: orders, refunds, Route transfers (SCRUM-1011)                       */
/* -------------------------------------------------------------------------- */

/**
 * A Razorpay order for one ticket order, for the amount read from
 * `ticket_orders.total_minor` by the caller. The receipt is our order id, so a
 * person in the Razorpay dashboard can find it; `notes` are for them only, the
 * webhook resolves the order from `provider_order_ref`. An answer for any other
 * amount or currency is refused, not stored.
 */
export async function createTicketOrder(input: { orderId: string; amountMinor: number; currency: string }): Promise<RazorpayOrder> {
  const order = await call(orderSchema, "POST", "/orders", {
    amount: input.amountMinor,
    currency: input.currency,
    receipt: input.orderId,
    notes: { ticket_order_id: input.orderId },
  })
  if (order.amount !== input.amountMinor || order.currency !== input.currency) {
    throw new RazorpayError(502, "Razorpay created the order for another amount")
  }
  return order
}

const ticketPaymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().nullable().optional(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.string(),
  created_at: z.number().int(),
})
export type RazorpayPayment = z.infer<typeof ticketPaymentSchema>

/** An order's payments, for the reconcile job: a webhook lost is a payment found here. */
export async function orderPayments(orderRef: string): Promise<RazorpayPayment[]> {
  return (await call(z.object({ items: z.array(ticketPaymentSchema) }), "GET", `/orders/${encodeURIComponent(orderRef)}/payments`)).items
}

const refundSchema = z.object({
  id: z.string().min(1),
  payment_id: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.string(),
})
export type RazorpayRefund = z.infer<typeof refundSchema>

/** Refund part or all of a payment. Normal speed: instant refunds cost extra and are Razorpay's to offer. */
export async function refundPayment(input: { paymentId: string; amountMinor: number; orderId: string }): Promise<RazorpayRefund> {
  return call(refundSchema, "POST", `/payments/${encodeURIComponent(input.paymentId)}/refund`, {
    amount: input.amountMinor,
    speed: "normal",
    receipt: input.orderId,
    notes: { ticket_order_id: input.orderId },
  })
}

/** A payment's refunds: asked before refunding again, so a retry never refunds twice. */
export async function paymentRefunds(paymentId: string): Promise<RazorpayRefund[]> {
  return (await call(z.object({ items: z.array(refundSchema) }), "GET", `/payments/${encodeURIComponent(paymentId)}/refunds`)).items
}

const transferSchema = z.object({
  id: z.string().min(1),
  recipient: z.string(),
  amount: z.number().int(),
  currency: z.string(),
})
export type RazorpayTransfer = z.infer<typeof transferSchema>

/** A payment's Route transfers: asked before transferring again, so a retry never pays an organizer twice. */
export async function paymentTransfers(paymentId: string): Promise<RazorpayTransfer[]> {
  return (await call(z.object({ items: z.array(transferSchema) }), "GET", `/payments/${encodeURIComponent(paymentId)}/transfers`)).items
}

/**
 * Transfer the organizer's share of a captured payment to their linked
 * account, held until `onHoldUntil` (three days after the event ends), when
 * Razorpay releases it to their bank. An answer for another account or amount
 * is refused.
 */
export async function createTransfer(input: {
  paymentId: string
  account: string
  amountMinor: number
  currency: string
  onHoldUntil: Date
  orderId: string
}): Promise<RazorpayTransfer> {
  const { items } = await call(z.object({ items: z.array(transferSchema).length(1) }), "POST", `/payments/${encodeURIComponent(input.paymentId)}/transfers`, {
    transfers: [
      {
        account: input.account,
        amount: input.amountMinor,
        currency: input.currency,
        on_hold: 1,
        on_hold_until: Math.floor(input.onHoldUntil.getTime() / 1000),
        notes: { ticket_order_id: input.orderId },
      },
    ],
  })
  const transfer = items[0]
  if (transfer.recipient !== input.account || transfer.amount !== input.amountMinor || transfer.currency !== input.currency) {
    throw new RazorpayError(502, "Razorpay made the transfer to another account or amount")
  }
  return transfer
}

/**
 * Move a Route transfer's settlement hold (`PATCH /v1/transfers/:id`, "Modify
 * settlement hold": `on_hold` boolean, `on_hold_until` Unix seconds; answers the
 * transfer). Used to extend a held payout when its event is postponed
 * (SCRUM-1014); never to shorten one. An answer that holds less long is refused.
 */
/** A Route transfer's current settlement hold (`GET /v1/transfers/:id`), or null when it has none. */
export async function transferHold(transferId: string): Promise<Date | null> {
  const t = await call(z.object({ id: z.string(), on_hold_until: z.number().int().nullable().optional() }), "GET", `/transfers/${encodeURIComponent(transferId)}`)
  return t.on_hold_until ? new Date(t.on_hold_until * 1000) : null
}

export async function modifyTransferHold(transferId: string, onHoldUntil: Date): Promise<void> {
  const until = Math.floor(onHoldUntil.getTime() / 1000)
  const answer = await call(z.object({ id: z.string(), on_hold_until: z.number().int().nullable().optional() }), "PATCH", `/transfers/${encodeURIComponent(transferId)}`, {
    on_hold: true,
    on_hold_until: until,
  })
  if (answer.id !== transferId || (answer.on_hold_until ?? 0) < until) throw new RazorpayError(502, "Razorpay did not extend the transfer's hold")
}

const reversalSchema = z.object({ id: z.string().min(1), transfer_id: z.string(), amount: z.number().int() })

/** Take back part or all of a transfer: a refund's share, out of the organizer's held payout. */
export async function reverseTransfer(transferId: string, amountMinor: number): Promise<z.infer<typeof reversalSchema>> {
  return call(reversalSchema, "POST", `/transfers/${encodeURIComponent(transferId)}/reversals`, { amount: amountMinor })
}

/* -------------------------------------------------------------------------- */
/* Route linked accounts                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A Route linked account's onboarding state at Razorpay (`activated`,
 * `under_review`, `needs_clarification`, `suspended`, ...), read before an
 * admin marks the organization's payouts active (SCRUM-1014). Hosted KYC
 * onboarding is Razorpay's and out of our scope: this only reads its word.
 */
export async function linkedAccountStatus(accountId: string): Promise<string> {
  return (await call(z.object({ id: z.string(), status: z.string() }), "GET", `/v2/accounts/${encodeURIComponent(accountId)}`)).status
}
