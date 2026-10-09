import { Prisma } from "@prisma/client"

import { auditLog } from "./audit-log"
import { BILLING_PLANS, chargeMinor, isBillingPlanKey } from "./billing-plans"
import { db } from "./db"
import { endPaidEntitlement, recordPaidEntitlement } from "./entitlements"
import { logger } from "./logger"

/**
 * What a verified Razorpay delivery does (plan v2 §9.2).
 *
 * The route has already checked the signature over the raw body. Here:
 *
 *   1. **Recorded first**, keyed on Razorpay's event id. A replay hits the
 *      unique index and does nothing — unless the first attempt never got as
 *      far as applying it, in which case the retry applies it.
 *   2. **Resolved from our own row.** The organisation comes from the
 *      `billing_checkouts` row this server wrote when it started the purchase,
 *      found by the subscription or order id. `notes` is never read: anyone
 *      with access to the Razorpay dashboard can write notes.
 *   3. **Held to the price table.** A charge is applied only if its amount and
 *      currency are exactly what `BILLING_PLANS` says, for the plan the
 *      checkout was started on.
 *   4. **Ordered by Razorpay's clock.** An event older than the last one
 *      applied to that purchase is recorded and changes nothing, so a late
 *      `charged` cannot revive a cancelled subscription.
 *
 * The entitlement is written here and nowhere else on the paid path. The
 * browser's return from Checkout writes nothing.
 */

/**
 * After a subscription's paid-up date, how long Analytics stays on while
 * Razorpay retries a failed renewal. Razorpay sends `subscription.halted` once
 * it gives up, which ends it immediately, so this is only the window between
 * the cycle ending and the retry succeeding or the halt arriving.
 */
export const RENEWAL_GRACE_MS = 3 * 24 * 60 * 60 * 1000

const PROVIDER = "razorpay"

/** Why a delivery changed nothing. Stored in `payment_events.error`. */
export type Refused =
  | "unknown_ref"
  | "plan_mismatch"
  | "amount_mismatch"
  | "stale"
  | "malformed"

export interface DeliveryResult {
  duplicate: boolean
  applied: boolean
  refused?: Refused
}

interface Entity {
  id?: unknown
  [key: string]: unknown
}

interface Delivery {
  event: string
  created_at?: number
  payload?: Record<string, { entity?: Entity } | undefined>
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const at = (unixSeconds: unknown): Date | null => {
  const n = num(unixSeconds)
  return n === null ? null : new Date(n * 1000)
}

function isUniqueViolation(err: unknown): boolean {
  // The code only: the driver adapter does not populate `meta.target`
  // (memory: prisma-p2002-no-meta-target), and this table has one unique key.
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
}

/** Record one verified delivery and apply it. Idempotent on `eventId`. */
export async function recordRazorpayDelivery(
  eventId: string,
  delivery: Delivery,
  now: Date = new Date()
): Promise<DeliveryResult> {
  let rowId: string
  try {
    const row = await db.payment_events.create({
      data: {
        provider: PROVIDER,
        provider_event_id: eventId,
        type: delivery.event,
        payload: delivery as unknown as Prisma.InputJsonValue,
        received_at: now,
      },
      select: { id: true },
    })
    rowId = row.id
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const seen = await db.payment_events.findUniqueOrThrow({
      where: { provider_provider_event_id: { provider: PROVIDER, provider_event_id: eventId } },
      select: { id: true, processed_at: true, error: true },
    })
    // Already applied or already refused: the replay is a no-op. Neither
    // means the first attempt died before deciding, so this one decides.
    if (seen.processed_at || seen.error) return { duplicate: true, applied: false }
    rowId = seen.id
  }

  const outcome = await db.$transaction((tx) => apply(tx, delivery))
  await db.payment_events.update({
    where: { id: rowId },
    data: {
      checkout_id: outcome.checkoutId ?? null,
      ...(outcome.refused ? { error: outcome.refused } : { processed_at: new Date() }),
    },
  })

  if (outcome.refused) {
    const log = outcome.refused === "amount_mismatch" || outcome.refused === "plan_mismatch" ? logger.error : logger.warn
    log("Razorpay delivery refused", { eventId, type: delivery.event, refused: outcome.refused })
  }
  for (const entry of outcome.audit) auditLog(entry)

  return { duplicate: false, applied: outcome.applied, ...(outcome.refused ? { refused: outcome.refused } : {}) }
}

interface Outcome {
  applied: boolean
  refused?: Refused
  checkoutId?: string
  audit: Parameters<typeof auditLog>[0][]
}

const refuse = (refused: Refused, checkoutId?: string): Outcome => ({
  applied: false,
  refused,
  ...(checkoutId ? { checkoutId } : {}),
  audit: [],
})

async function apply(tx: Prisma.TransactionClient, delivery: Delivery): Promise<Outcome> {
  const type = delivery.event
  if (type.startsWith("subscription.")) return applySubscription(tx, delivery)
  if (type === "order.paid") return applyOrderPaid(tx, delivery)
  if (type === "payment.failed") return applyPaymentFailed(tx, delivery)
  // payment.captured and anything else: kept as a record, nothing to change.
  // An order's entitlement waits for order.paid, which carries the order.
  return { applied: false, audit: [] }
}

/* -------------------------------------------------------------------------- */

async function applySubscription(tx: Prisma.TransactionClient, delivery: Delivery): Promise<Outcome> {
  const sub = delivery.payload?.subscription?.entity
  const subId = str(sub?.id)
  const eventAt = at(delivery.created_at)
  if (!sub || !subId || !eventAt) return refuse("malformed")

  const checkout = await tx.billing_checkouts.findUnique({ where: { provider_ref: subId } })
  if (!checkout || checkout.kind !== "subscription") return refuse("unknown_ref")
  if (checkout.status_at && eventAt < checkout.status_at) return refuse("stale", checkout.id)
  if (str(sub.plan_id) !== checkout.provider_plan_id) return refuse("plan_mismatch", checkout.id)
  if (!isBillingPlanKey(checkout.plan_key)) return refuse("plan_mismatch", checkout.id)
  const plan = BILLING_PLANS[checkout.plan_key]

  const subStatus = str(sub.status) ?? delivery.event.slice("subscription.".length)
  const currentEnd = at(sub.current_end)
  const subject = { kind: "org" as const, id: checkout.org_id }
  const audit: Outcome["audit"] = []

  if (delivery.event === "subscription.charged") {
    const payment = delivery.payload?.payment?.entity
    const amount = num(payment?.amount)
    if (
      amount === null ||
      amount !== chargeMinor(plan) ||
      amount !== checkout.amount_minor ||
      str(payment?.currency) !== "INR" ||
      !currentEnd
    ) {
      return refuse("amount_mismatch", checkout.id)
    }
    const startsAt = at(sub.start_at) ?? at(sub.current_start) ?? eventAt
    const granted = await recordPaidEntitlement(tx, {
      subject,
      product: plan.product,
      source: "razorpay",
      externalRef: subId,
      startsAt,
      expiresAt: new Date(currentEnd.getTime() + RENEWAL_GRACE_MS),
    })
    audit.push({
      action: "entitlement.paid",
      resource: "organisation",
      resourceId: checkout.org_id,
      details: {
        product: plan.product,
        plan: plan.key,
        source: "razorpay",
        externalRef: subId,
        paymentId: str(payment?.id),
        invoiceId: str(payment?.invoice_id),
        expiresAt: granted.expiresAt?.toISOString() ?? null,
      },
    })
  }

  if (
    delivery.event === "subscription.halted" ||
    delivery.event === "subscription.cancelled" ||
    delivery.event === "subscription.completed"
  ) {
    // A halt stops Analytics now. A cancellation or completion ends it when
    // Razorpay says the subscription ended — at the cycle's end for a
    // cancel-at-cycle-end — and never later than it already ends.
    const endAt = delivery.event === "subscription.halted" ? eventAt : (at(sub.ended_at) ?? eventAt)
    const ended = await endPaidEntitlement(tx, "razorpay", subId, endAt)
    if (ended) {
      audit.push({
        action: "entitlement.ended",
        resource: "organisation",
        resourceId: checkout.org_id,
        details: {
          product: plan.product,
          source: "razorpay",
          externalRef: subId,
          reason: delivery.event,
          expiresAt: ended.expiresAt.toISOString(),
        },
      })
    }
  }

  await tx.billing_checkouts.update({
    where: { id: checkout.id },
    data: { status: subStatus, status_at: eventAt, ...(currentEnd ? { current_end: currentEnd } : {}) },
  })
  return { applied: true, checkoutId: checkout.id, audit }
}

async function applyOrderPaid(tx: Prisma.TransactionClient, delivery: Delivery): Promise<Outcome> {
  const order = delivery.payload?.order?.entity
  const payment = delivery.payload?.payment?.entity
  const orderId = str(order?.id)
  const eventAt = at(delivery.created_at)
  if (!order || !orderId || !eventAt) return refuse("malformed")

  const checkout = await tx.billing_checkouts.findUnique({ where: { provider_ref: orderId } })
  if (!checkout || checkout.kind !== "order" || !checkout.event_id) return refuse("unknown_ref")
  if (checkout.plan_key !== "event_pass") return refuse("plan_mismatch", checkout.id)

  const want = chargeMinor(BILLING_PLANS.event_pass)
  const amount = num(order.amount)
  const paid = num(order.amount_paid)
  if (
    amount !== want ||
    checkout.amount_minor !== want ||
    paid === null ||
    paid < want ||
    str(order.currency) !== "INR" ||
    str(order.status) !== "paid"
  ) {
    return refuse("amount_mismatch", checkout.id)
  }

  await recordPaidEntitlement(tx, {
    subject: { kind: "org", id: checkout.org_id },
    product: "event_pass",
    eventId: checkout.event_id,
    source: "razorpay",
    externalRef: orderId,
    startsAt: eventAt,
    // An Event Pass unlocks its event for good (audit §5.1).
    expiresAt: null,
  })
  await tx.billing_checkouts.update({
    where: { id: checkout.id },
    data: { status: "paid", status_at: eventAt },
  })
  return {
    applied: true,
    checkoutId: checkout.id,
    audit: [
      {
        action: "entitlement.paid",
        resource: "organisation",
        resourceId: checkout.org_id,
        details: {
          product: "event_pass",
          eventId: checkout.event_id,
          source: "razorpay",
          externalRef: orderId,
          paymentId: str(payment?.id),
        },
      },
    ],
  }
}

/** A failed attempt at an order: say so on the purchase, unless it was since paid. */
async function applyPaymentFailed(tx: Prisma.TransactionClient, delivery: Delivery): Promise<Outcome> {
  const orderId = str(delivery.payload?.payment?.entity?.order_id)
  const eventAt = at(delivery.created_at)
  if (!orderId || !eventAt) return { applied: false, audit: [] }
  const checkout = await tx.billing_checkouts.findUnique({ where: { provider_ref: orderId } })
  if (!checkout) return { applied: false, audit: [] }
  if (checkout.status === "paid") return { applied: false, checkoutId: checkout.id, audit: [] }
  await tx.billing_checkouts.update({
    where: { id: checkout.id },
    data: { status: "failed", status_at: eventAt },
  })
  return { applied: true, checkoutId: checkout.id, audit: [] }
}
