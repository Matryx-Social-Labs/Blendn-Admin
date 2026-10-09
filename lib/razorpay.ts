import { createHmac, timingSafeEqual } from "crypto"

import { BILLING_PLANS, chargeMinor, type BillingPlan } from "./billing-plans"
import { razorpayKeyModeProblem } from "./env"

/**
 * Razorpay, over its REST API (plan v2 §9.2).
 *
 * Plain `fetch`, not the `razorpay` npm SDK: the dashboard makes five calls
 * (create a plan, list plans, create a subscription, cancel it, create an
 * order) and verifies one signature. The SDK would add a dependency and its
 * transitive tree to the server bundle for that, and hide the request shape a
 * reviewer needs to see. The webhook signature is ten lines of `crypto`.
 *
 * Off when unset: `razorpayConfig()` is null and every caller says payments
 * are not switched on, rather than failing on a click.
 */

const API = "https://api.razorpay.com/v1"
const TIMEOUT_MS = 15_000

export interface RazorpayConfig {
  keyId: string
  keySecret: string
}

/** The API keys, or null when payments are off here. Refuses a key in the wrong mode. */
export function razorpayConfig(): RazorpayConfig | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim()
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim()
  if (!keyId || !keySecret) return null
  const problem = razorpayKeyModeProblem(keyId, process.env.RAILWAY_ENVIRONMENT_NAME)
  if (problem) throw new Error(problem)
  return { keyId, keySecret }
}

/** The webhook's shared secret, or null when the webhook is off. */
export function razorpayWebhookSecret(): string | null {
  return process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || null
}

/**
 * Did Razorpay sign exactly these bytes?
 *
 * The HMAC is over the RAW body as received. Parsing and re-serialising first
 * changes whitespace and key order, so a genuine delivery would fail — and a
 * verifier that "fixes" that by comparing against a re-serialised body has
 * stopped checking what was sent.
 *
 * Constant-time, and the length is compared first because `timingSafeEqual`
 * throws on unequal lengths (as in `lib/leads.ts`). Never throws.
 */
export function verifyWebhookSignature(
  raw: string,
  signature: string | null | undefined,
  secret: string
): boolean {
  if (!signature || !secret) return false
  const want = Buffer.from(createHmac("sha256", secret).update(raw, "utf8").digest("hex"))
  const given = Buffer.from(signature.trim())
  return given.length === want.length && timingSafeEqual(given, want)
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

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const config = razorpayConfig()
  if (!config) throw new RazorpayError(503, "Razorpay is not configured")
  const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64")
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  })
  const json = (await res.json().catch(() => null)) as
    | (T & { error?: { description?: string } })
    | null
  if (!res.ok || json === null) {
    // Razorpay's own sentence when it sent one; never the request, which
    // carries the key in its header.
    throw new RazorpayError(res.status, json?.error?.description ?? `Razorpay answered ${res.status}`)
  }
  return json
}

/* -------------------------------------------------------------------------- */
/* Plans                                                                       */
/* -------------------------------------------------------------------------- */

export interface RazorpayPlan {
  id: string
  period: string
  interval: number
  item: { name: string; amount: number; currency: string }
  notes?: Record<string, string> | []
}

/** Every plan on the account, newest first. */
export async function listPlans(): Promise<RazorpayPlan[]> {
  const out: RazorpayPlan[] = []
  for (let skip = 0; ; skip += 100) {
    const page = await call<{ items: RazorpayPlan[] }>("GET", `/plans?count=100&skip=${skip}`)
    out.push(...page.items)
    if (page.items.length < 100) return out
  }
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
  return call<RazorpayPlan>("POST", "/plans", {
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

const PLAN_CACHE_MS = 10 * 60 * 1000
let planCache: { at: number; plans: RazorpayPlan[] } | null = null

/**
 * The Razorpay plan id for a subscription plan in our table, or null when
 * `scripts/razorpay-plans.ts --apply` has not created it yet.
 *
 * Cached for ten minutes: plans change only when the script runs, and a
 * checkout click should not list every plan on the account.
 */
export async function planIdFor(plan: BillingPlan, now = Date.now()): Promise<string | null> {
  if (!planCache || now - planCache.at > PLAN_CACHE_MS) {
    planCache = { at: now, plans: await listPlans() }
  }
  return planCache.plans.find((p) => planMatches(p, plan))?.id ?? null
}

/* -------------------------------------------------------------------------- */
/* Subscriptions and orders                                                    */
/* -------------------------------------------------------------------------- */

export interface RazorpaySubscription {
  id: string
  plan_id: string
  status: string
  short_url?: string
}

export async function createSubscription(input: {
  planId: string
  totalCount: number
  orgId: string
}): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>("POST", "/subscriptions", {
    plan_id: input.planId,
    total_count: input.totalCount,
    customer_notify: 1,
    // For a person reading the Razorpay dashboard. The webhook never reads
    // it: the organisation comes from our own `billing_checkouts` row.
    notes: { org_id: input.orgId },
  })
}

/** At the end of the paid cycle when it is running; at once when it is not. */
export async function cancelSubscription(id: string, atCycleEnd: boolean): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, {
    cancel_at_cycle_end: atCycleEnd ? 1 : 0,
  })
}

export interface RazorpayOrder {
  id: string
  amount: number
  currency: string
  status: string
}

export async function createEventPassOrder(input: {
  orgId: string
  eventId: string
  receipt: string
}): Promise<RazorpayOrder> {
  return call<RazorpayOrder>("POST", "/orders", {
    amount: chargeMinor(BILLING_PLANS.event_pass),
    currency: "INR",
    receipt: input.receipt,
    notes: { org_id: input.orgId, event_id: input.eventId },
  })
}
