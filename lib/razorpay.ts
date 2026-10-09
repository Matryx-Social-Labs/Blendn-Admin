import { createHmac, timingSafeEqual } from "crypto"
import { z } from "zod"

import { BILLING_PLANS, chargeMinor, type BillingPlan } from "./billing-plans"
import { razorpayKeys } from "./env"

/**
 * Razorpay, over its REST API (plan v2 §9.2).
 *
 * Plain `fetch`, not the `razorpay` npm SDK: the dashboard makes five calls
 * (create a plan, list plans, create a subscription, cancel it, create an
 * order) and verifies one signature. The SDK would add a dependency and its
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

const API = "https://api.razorpay.com/v1"
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

async function call<S extends z.ZodType>(
  schema: S,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<z.infer<S>> {
  const keys = razorpayKeys()
  if (!keys) throw new RazorpayError(503, "Razorpay is not configured")
  const auth = Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64")
  const res = await fetch(`${API}${path}`, {
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
    throw new RazorpayError(res.status, description ?? `Razorpay answered ${res.status}`)
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
      name: `Blend'n ${plan.label}`,
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
    // it: the organisation comes from our own `billing_checkouts` row.
    notes: { org_id: input.orgId },
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

/** How long Razorpay lets a created subscription wait, for our own "still open" rule. */
export const CREATED_CHECKOUT_LIFETIME_MS = SUBSCRIPTION_EXPIRES_AFTER_S * 1000
