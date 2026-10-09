import "server-only"

import { Prisma } from "@prisma/client"
import { z } from "zod"

import { db } from "./db"
import { endPaidEntitlement, passHeldElsewhere, recordPaidEntitlement, type Subject } from "./entitlements"
import { logger } from "./logger"
import { cancelSubscription } from "./razorpay"

/**
 * What a verified Razorpay delivery does (plan v2 §9.2).
 *
 * The route has already checked the signature over the raw bytes. Here, in
 * ONE transaction:
 *
 *   1. **Claimed.** `INSERT … ON CONFLICT DO NOTHING` on Razorpay's event id
 *      and on the hash of the signed body. A replay, a re-send under a new
 *      event id, or a concurrent twin (which blocks on the unique key until
 *      this transaction ends) inserts nothing and changes nothing.
 *   2. **Locked.** The purchase's `billing_checkouts` row, `FOR UPDATE`, so
 *      two deliveries about one subscription apply one after the other.
 *   3. **Resolved from our own row**, found by the subscription, order or
 *      payment id. `notes` is never read: anyone with access to the Razorpay
 *      dashboard can write notes.
 *   4. **Held to what this server asked for**: the checkout's own amount,
 *      INR, and its Razorpay plan. Never the live price table, so a later
 *      price change cannot refuse an old subscriber's renewal.
 *   5. **Applied, marked and audited**, and a failure anywhere rolls the
 *      claim back, so Razorpay's retry finds the delivery new again.
 *
 * Ordering is Razorpay's clock (`created_at`), per kind of change:
 *
 *   - the checkout's status moves only forward (`status_at < eventAt`);
 *   - a charge always records the payment, and extends access unless the
 *     subscription already ended (cancelled / completed) at or after it;
 *   - a halt ends access unless a later charge has already applied;
 *   - two events in the same second are decided by the lock and these rules.
 *
 * The entitlement is written here and nowhere else on the paid path. The
 * browser's return from Checkout writes nothing.
 */

/**
 * After a subscription's paid-up date, how long Analytics stays on while
 * Razorpay retries a failed renewal. Razorpay sends `subscription.halted` once
 * it gives up, which ends it, so this is only the window between the cycle
 * ending and the retry succeeding or the halt arriving.
 */
export const RENEWAL_GRACE_MS = 3 * 24 * 60 * 60 * 1000

const PROVIDER = "razorpay"
const TERMINAL = ["cancelled", "completed"]

/** Why a delivery changed nothing. Stored in `payment_events.error`. */
export type Refused = "unknown_ref" | "plan_mismatch" | "amount_mismatch" | "malformed"

export interface DeliveryResult {
  duplicate: boolean
  applied: boolean
  refused?: Refused
}

const entity = z.record(z.string(), z.unknown())

/** What the route accepts as a delivery, after the signature. */
export const deliverySchema = z.object({
  event: z.string().min(1).max(100),
  created_at: z.number().int().positive(),
  payload: z.record(z.string(), z.object({ entity: entity }).partial()).default({}),
})
export type Delivery = z.infer<typeof deliverySchema>
type Entity = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const at = (unixSeconds: unknown): Date | null => {
  const n = num(unixSeconds)
  return n === null ? null : new Date(n * 1000)
}
const entityOf = (d: Delivery, key: string): Entity | undefined => d.payload[key]?.entity

/** What of a delivery is kept: ids, amounts, states and times. Never the payer's email, phone or card. */
const KEEP: Record<string, readonly string[]> = {
  subscription: ["id", "plan_id", "status", "current_start", "current_end", "start_at", "ended_at", "charge_at", "paid_count", "total_count"],
  payment: ["id", "order_id", "invoice_id", "amount", "currency", "status", "method", "captured", "error_code", "error_reason", "created_at"],
  order: ["id", "amount", "amount_paid", "amount_due", "currency", "receipt", "status", "attempts", "created_at"],
  refund: ["id", "payment_id", "amount", "currency", "status", "created_at"],
  dispute: ["id", "payment_id", "amount", "currency", "status", "phase", "reason_code", "created_at"],
  payment_link: ["id", "amount", "amount_paid", "currency", "status", "reference_id", "created_at", "updated_at"],
}

export function redactDelivery(d: Delivery): Prisma.InputJsonValue {
  const payload: Record<string, unknown> = {}
  for (const [key, keep] of Object.entries(KEEP)) {
    const e = entityOf(d, key)
    if (!e) continue
    payload[key] = { entity: Object.fromEntries(keep.filter((k) => k in e).map((k) => [k, e[k]])) }
  }
  return { event: d.event, created_at: d.created_at, payload } as Prisma.InputJsonValue
}

type Tx = Prisma.TransactionClient

interface Audit {
  action: string
  orgId: string
  details: Prisma.InputJsonValue
  /** What the row is about, when not the organisation: a placement charge. */
  resource?: { kind: string; id: string }
}

interface Outcome {
  applied: boolean
  refused?: Refused
  checkoutId?: string
  audit: Audit[]
  /** Calls to Razorpay that must wait for the commit (a refunded subscription's cancel). */
  after: Array<() => Promise<unknown>>
}

const nothing = (checkoutId?: string): Outcome => ({ applied: false, audit: [], after: [], ...(checkoutId ? { checkoutId } : {}) })
const refuse = (refused: Refused, checkoutId?: string): Outcome => ({ ...nothing(checkoutId), refused })

/** Record one verified delivery and apply it. Idempotent on the event id and on the body. */
export async function recordRazorpayDelivery(
  eventId: string,
  bodySha256: string,
  delivery: Delivery,
  now: Date = new Date()
): Promise<DeliveryResult> {
  const result = await db.$transaction(
    async (tx) => {
      const { count } = await tx.payment_events.createMany({
        data: [
          {
            provider: PROVIDER,
            provider_event_id: eventId,
            body_sha256: bodySha256,
            type: delivery.event,
            payload: redactDelivery(delivery),
            received_at: now,
          },
        ],
        skipDuplicates: true,
      })
      if (count === 0) return { duplicate: true, outcome: nothing() }

      const outcome = await apply(tx, delivery)
      await tx.payment_events.update({
        where: { provider_provider_event_id: { provider: PROVIDER, provider_event_id: eventId } },
        data: {
          checkout_id: outcome.checkoutId ?? null,
          ...(outcome.refused ? { error: outcome.refused } : { processed_at: new Date() }),
        },
      })
      for (const a of outcome.audit) {
        await tx.audit_logs.create({
          data: {
            action: a.action,
            resource: a.resource?.kind ?? "organisation",
            resource_id: a.resource?.id ?? a.orgId,
            details: a.details,
          },
        })
      }
      return { duplicate: false, outcome }
    },
    { maxWait: 5_000, timeout: 15_000 }
  )

  const { outcome } = result
  if (outcome.refused) {
    const money = /^(subscription\.charged|order\.paid|payment_link\.paid)$/.test(delivery.event)
    ;(money || outcome.refused !== "unknown_ref" ? logger.error : logger.warn)("Razorpay delivery refused", {
      eventId,
      type: delivery.event,
      refused: outcome.refused,
      ref: providerRefOf(delivery),
    })
  }
  for (const call of outcome.after) {
    await call().catch((err: unknown) =>
      logger.error("Razorpay follow-up call failed; do it from the Razorpay dashboard", {
        eventId,
        ref: providerRefOf(delivery),
        error: err instanceof Error ? err.message : String(err),
      })
    )
  }
  return {
    duplicate: result.duplicate,
    applied: outcome.applied,
    ...(outcome.refused ? { refused: outcome.refused } : {}),
  }
}

/** The id an operator searches the Razorpay dashboard for. */
function providerRefOf(d: Delivery): string | null {
  return (
    str(entityOf(d, "subscription")?.id) ??
    str(entityOf(d, "order")?.id) ??
    str(entityOf(d, "payment_link")?.id) ??
    str(entityOf(d, "payment")?.id) ??
    str(entityOf(d, "refund")?.payment_id) ??
    str(entityOf(d, "dispute")?.payment_id)
  )
}

/* -------------------------------------------------------------------------- */

interface Checkout {
  id: string
  kind: "subscription" | "order" | "payment_link"
  provider_ref: string
  provider_plan_id: string | null
  org_id: string
  event_id: string | null
  /** The venue a Venue Pro subscription is for; null for an organisation's own purchase. */
  venue_id: string | null
  /** The placement charge a payment link is for. */
  charge_id: string | null
  plan_key: string
  amount_minor: number
  currency: string
  status: string
  status_at: Date | null
  current_end: Date | null
}

/** Our row for a provider reference, locked until the transaction ends. */
async function lockCheckout(tx: Tx, providerRef: string): Promise<Checkout | null> {
  const rows = await tx.$queryRaw<Checkout[]>`
    SELECT id, kind::text AS kind, provider_ref, provider_plan_id, org_id::text AS org_id, event_id::text AS event_id,
           venue_id::text AS venue_id, charge_id::text AS charge_id, plan_key, amount_minor, currency, status, status_at, current_end
      FROM billing_checkouts
     WHERE provider = ${PROVIDER} AND provider_ref = ${providerRef}
       FOR UPDATE`
  return rows[0] ?? null
}

/** Move the checkout's status forward only: an older delivery never overwrites a newer one. */
async function advance(tx: Tx, c: Checkout, eventAt: Date, next: string, currentEnd?: Date | null) {
  await tx.billing_checkouts.updateMany({
    where: { id: c.id, OR: [{ status_at: null }, { status_at: { lt: eventAt } }] },
    data: { status: next, status_at: eventAt, ...(currentEnd ? { current_end: currentEnd } : {}) },
  })
}

/** Remember a captured payment, once (a re-sent charge finds it). */
async function recordPayment(tx: Tx, c: Checkout, payment: Entity, eventAt: Date) {
  const id = str(payment.id)
  const amount = num(payment.amount)
  if (!id || amount === null) return
  await tx.billing_payments.createMany({
    data: [
      {
        provider: PROVIDER,
        provider_payment_id: id,
        checkout_id: c.id,
        amount_minor: amount,
        currency: str(payment.currency) ?? "INR",
        invoice_id: str(payment.invoice_id),
        captured_at: eventAt,
      },
    ],
    skipDuplicates: true,
  })
}

/**
 * Who a purchase's entitlement belongs to, and what it is, from our own row:
 * a venue's Venue Pro when the checkout names a venue, else the
 * organisation's Analytics or Event Pass. Never from the payload.
 */
const subjectOf = (c: Checkout): Subject => (c.venue_id ? { kind: "venue", id: c.venue_id } : { kind: "org", id: c.org_id })
const subscriptionProduct = (c: Checkout): "analytics" | "venue_pro" => (c.venue_id ? "venue_pro" : "analytics")

async function apply(tx: Tx, d: Delivery): Promise<Outcome> {
  if (d.event.startsWith("subscription.")) return applySubscription(tx, d)
  if (d.event === "order.paid") return applyOrderPaid(tx, d)
  if (d.event === "payment_link.paid") return applyPaymentLinkPaid(tx, d)
  if (d.event === "payment.failed") return applyPaymentFailed(tx, d)
  if (d.event === "refund.processed") return applyRefund(tx, d)
  if (d.event.startsWith("payment.dispute.")) return applyDispute(tx, d)
  // payment.captured and anything else: kept as a (redacted) record. An
  // order's entitlement waits for order.paid; a charge's for subscription.charged.
  return nothing()
}

async function applySubscription(tx: Tx, d: Delivery): Promise<Outcome> {
  const sub = entityOf(d, "subscription")
  const subId = str(sub?.id)
  const eventAt = at(d.created_at)
  if (!sub || !subId || !eventAt) return refuse("malformed")

  const c = await lockCheckout(tx, subId)
  if (!c || c.kind !== "subscription") return refuse("unknown_ref")
  if (str(sub.plan_id) !== c.provider_plan_id) return refuse("plan_mismatch", c.id)

  const status = str(sub.status) ?? d.event.slice("subscription.".length)
  const currentEnd = at(sub.current_end)
  const out: Outcome = { applied: true, checkoutId: c.id, audit: [], after: [] }

  if (d.event === "subscription.charged") {
    const payment = entityOf(d, "payment")
    if (!payment || num(payment.amount) !== c.amount_minor || str(payment.currency) !== c.currency || !currentEnd) {
      return refuse("amount_mismatch", c.id)
    }
    await recordPayment(tx, c, payment, eventAt)
    const endedSince = TERMINAL.includes(c.status) && c.status_at !== null && c.status_at >= eventAt
    if (!endedSince) {
      const granted = await recordPaidEntitlement(tx, {
        subject: subjectOf(c),
        product: subscriptionProduct(c),
        source: "razorpay",
        externalRef: subId,
        startsAt: at(sub.start_at) ?? at(sub.current_start) ?? eventAt,
        expiresAt: new Date(currentEnd.getTime() + RENEWAL_GRACE_MS),
      })
      out.audit.push({
        action: "entitlement.paid",
        orgId: c.org_id,
        details: {
          product: subscriptionProduct(c),
          ...(c.venue_id ? { venueId: c.venue_id } : {}),
          plan: c.plan_key,
          source: "razorpay",
          externalRef: subId,
          paymentId: str(payment.id),
          invoiceId: str(payment.invoice_id),
          expiresAt: granted.expiresAt?.toISOString() ?? null,
        },
      })
    }
  }

  if (d.event === "subscription.halted") {
    const laterCharge = await tx.billing_payments.count({
      where: { checkout_id: c.id, captured_at: { gt: eventAt }, status: "captured" },
    })
    if (laterCharge === 0) await endAccess(tx, out, c, subId, eventAt, d.event)
  }

  if (d.event === "subscription.cancelled" || d.event === "subscription.completed") {
    // At the cycle's end for a cancel-at-cycle-end (Razorpay sends this then),
    // and never later than it already ends.
    await endAccess(tx, out, c, subId, at(sub.ended_at) ?? eventAt, d.event)
  }

  await advance(tx, c, eventAt, status, currentEnd)
  return out
}

async function endAccess(tx: Tx, out: Outcome, c: Checkout, ref: string, endAt: Date, reason: string) {
  const ended = await endPaidEntitlement(tx, "razorpay", ref, endAt)
  if (!ended) return
  out.audit.push({
    action: "entitlement.ended",
    orgId: c.org_id,
    details: {
      product: c.kind === "order" ? "event_pass" : subscriptionProduct(c),
      ...(c.venue_id ? { venueId: c.venue_id } : {}),
      source: "razorpay",
      externalRef: ref,
      reason,
      expiresAt: ended.expiresAt.toISOString(),
    },
  })
}

async function applyOrderPaid(tx: Tx, d: Delivery): Promise<Outcome> {
  const order = entityOf(d, "order")
  const payment = entityOf(d, "payment")
  const orderId = str(order?.id)
  const eventAt = at(d.created_at)
  if (!order || !orderId || !eventAt) return refuse("malformed")

  const c = await lockCheckout(tx, orderId)
  if (!c || c.kind !== "order" || !c.event_id) return refuse("unknown_ref")
  if (c.plan_key !== "event_pass") return refuse("plan_mismatch", c.id)

  const amount = num(order.amount)
  const paid = num(order.amount_paid)
  if (amount !== c.amount_minor || paid === null || paid < c.amount_minor || str(order.currency) !== c.currency || str(order.status) !== "paid") {
    return refuse("amount_mismatch", c.id)
  }
  if (payment) await recordPayment(tx, c, payment, eventAt)

  const out: Outcome = { applied: true, checkoutId: c.id, audit: [], after: [] }
  // A second paid pass for an event the organisation already holds one for
  // (two tabs, two admins): nothing more to grant. Flagged for a refund.
  if (await passHeldElsewhere(tx, c.org_id, c.event_id, orderId, eventAt)) {
    logger.error("A second Event Pass was paid for one event; refund it from the Razorpay dashboard", {
      orderId,
      orgId: c.org_id,
      eventId: c.event_id,
    })
    out.audit.push({
      action: "entitlement.duplicate_pass",
      orgId: c.org_id,
      details: { eventId: c.event_id, externalRef: orderId, paymentId: str(payment?.id) },
    })
  } else {
    await recordPaidEntitlement(tx, {
      subject: subjectOf(c),
      product: "event_pass",
      eventId: c.event_id,
      source: "razorpay",
      externalRef: orderId,
      startsAt: eventAt,
      // An Event Pass unlocks its event for good (audit §5.1).
      expiresAt: null,
    })
    out.audit.push({
      action: "entitlement.paid",
      orgId: c.org_id,
      details: { product: "event_pass", eventId: c.event_id, source: "razorpay", externalRef: orderId, paymentId: str(payment?.id) },
    })
  }
  await advance(tx, c, eventAt, "paid")
  return out
}

/** A failed attempt at an order: say so on the purchase, unless it was since paid. */
async function applyPaymentFailed(tx: Tx, d: Delivery): Promise<Outcome> {
  const orderId = str(entityOf(d, "payment")?.order_id)
  const eventAt = at(d.created_at)
  if (!orderId || !eventAt) return nothing()
  const c = await lockCheckout(tx, orderId)
  if (!c || c.kind !== "order" || c.status === "paid") return nothing(c?.id)
  await advance(tx, c, eventAt, "failed")
  return { applied: true, checkoutId: c.id, audit: [], after: [] }
}

/** The purchase a payment belongs to, locked. */
async function checkoutOfPayment(tx: Tx, paymentId: string) {
  const payment = await tx.billing_payments.findUnique({
    where: { provider_provider_payment_id: { provider: PROVIDER, provider_payment_id: paymentId } },
    select: { id: true, amount_minor: true, checkout: { select: { provider_ref: true } } },
  })
  if (!payment) return null
  const c = await lockCheckout(tx, payment.checkout.provider_ref)
  return c ? { payment, c } : null
}

/**
 * A refund. A full one ends what it paid for at Razorpay's time for it; a
 * refunded subscription is also cancelled at Razorpay (after the commit), so
 * it cannot charge again. A partial refund is goodwill and changes nothing.
 */
async function applyRefund(tx: Tx, d: Delivery): Promise<Outcome> {
  const refund = entityOf(d, "refund")
  const paymentId = str(refund?.payment_id)
  const amount = num(refund?.amount)
  const eventAt = at(d.created_at)
  if (!refund || !paymentId || amount === null || !eventAt) return refuse("malformed")
  const found = await checkoutOfPayment(tx, paymentId)
  if (!found) return refuse("unknown_ref")
  const { payment, c } = found
  const out: Outcome = { applied: true, checkoutId: c.id, audit: [], after: [] }
  if (amount < payment.amount_minor) return out

  await tx.billing_payments.update({ where: { id: payment.id }, data: { status: "refunded" } })
  if (c.kind === "payment_link") {
    // The money went back: the charge it settled is void, with the refund as the reason.
    await voidRefundedCharge(tx, out, c, str(refund.id), eventAt)
    return out
  }
  await endAccess(tx, out, c, c.provider_ref, eventAt, d.event)
  if (c.kind === "subscription" && !TERMINAL.includes(c.status)) {
    const ref = c.provider_ref
    out.after.push(() => cancelSubscription(ref, false))
  }
  return out
}

/**
 * A chargeback. Opened or lost: what the payment bought ends at Razorpay's
 * time for it. Won: it comes back — a pass for good, a subscription to its
 * paid-up date plus the grace.
 */
async function applyDispute(tx: Tx, d: Delivery): Promise<Outcome> {
  const dispute = entityOf(d, "dispute")
  const paymentId = str(dispute?.payment_id)
  const eventAt = at(d.created_at)
  if (!dispute || !paymentId || !eventAt) return refuse("malformed")
  const found = await checkoutOfPayment(tx, paymentId)
  if (!found) return refuse("unknown_ref")
  const { payment, c } = found
  const out: Outcome = { applied: true, checkoutId: c.id, audit: [], after: [] }

  if (d.event === "payment.dispute.created" || d.event === "payment.dispute.lost") {
    await tx.billing_payments.update({
      where: { id: payment.id },
      data: { status: d.event === "payment.dispute.lost" ? "dispute_lost" : "disputed" },
    })
    await endAccess(tx, out, c, c.provider_ref, eventAt, d.event)
    return out
  }
  if (d.event === "payment.dispute.won") {
    await tx.billing_payments.update({ where: { id: payment.id }, data: { status: "dispute_won" } })
    const expiresAt =
      c.kind === "order" ? null : c.current_end ? new Date(c.current_end.getTime() + RENEWAL_GRACE_MS) : null
    // A payment link bought no entitlement; its charge is the admin's to settle again.
    if (c.kind !== "payment_link" && (c.kind === "order" || expiresAt)) {
      await recordPaidEntitlement(tx, {
        subject: subjectOf(c),
        product: c.kind === "order" ? "event_pass" : subscriptionProduct(c),
        eventId: c.kind === "order" ? c.event_id : null,
        source: "razorpay",
        externalRef: c.provider_ref,
        startsAt: eventAt,
        expiresAt,
      })
      out.audit.push({
        action: "entitlement.restored",
        orgId: c.org_id,
        details: { source: "razorpay", externalRef: c.provider_ref, reason: d.event },
      })
    }
    return out
  }
  return nothing(c.id)
}

/* -------------------------------------------------------------------------- */
/* Sponsor payment links (step 17, SCRUM-560)                                   */
/* -------------------------------------------------------------------------- */

interface LockedCharge {
  id: string
  status: "draft" | "agreed" | "settled" | "void"
  amount_minor: number
  currency: string
}

async function lockCharge(tx: Tx, id: string): Promise<LockedCharge | null> {
  const rows = await tx.$queryRaw<LockedCharge[]>`
    SELECT id::text AS id, status::text AS status, amount_minor, currency::text AS currency
      FROM placement_charges
     WHERE id = ${id}::uuid
       FOR UPDATE`
  return rows[0] ?? null
}

/**
 * A sponsor paid a placement's link: the charge is settled, once.
 *
 * Resolved from our own `billing_checkouts` row by the link's id: the charge
 * and the organisation are what this server recorded when it sent the link,
 * never the delivery's notes. Held to that row's amount and to the charge's,
 * in rupees, with Razorpay saying "paid". Only an `agreed` charge moves: a
 * replay finds it `settled` and changes nothing, and a charge an admin voided
 * meanwhile stays void (the payment is recorded and flagged for a refund),
 * so a late webhook never resurrects it.
 */
async function applyPaymentLinkPaid(tx: Tx, d: Delivery): Promise<Outcome> {
  const link = entityOf(d, "payment_link")
  const payment = entityOf(d, "payment")
  const linkId = str(link?.id)
  const eventAt = at(d.created_at)
  if (!link || !linkId || !eventAt) return refuse("malformed")

  const c = await lockCheckout(tx, linkId)
  if (!c || c.kind !== "payment_link" || !c.charge_id) return refuse("unknown_ref")
  const amount = num(link.amount)
  const paid = num(link.amount_paid)
  if (amount !== c.amount_minor || paid === null || paid < c.amount_minor || str(link.currency) !== c.currency || str(link.status) !== "paid") {
    return refuse("amount_mismatch", c.id)
  }
  const charge = await lockCharge(tx, c.charge_id)
  if (!charge) return refuse("unknown_ref", c.id)
  if (charge.amount_minor !== c.amount_minor || charge.currency !== c.currency) return refuse("amount_mismatch", c.id)

  if (payment) await recordPayment(tx, c, payment, eventAt)
  const out: Outcome = { applied: true, checkoutId: c.id, audit: [], after: [] }
  const resource = { kind: "placement_charges", id: charge.id }

  if (charge.status === "agreed") {
    await tx.placement_charges.update({
      where: { id: charge.id },
      data: { status: "settled", settled_at: eventAt, external_ref: linkId },
    })
    out.audit.push({
      action: "charge.settled",
      orgId: c.org_id,
      resource,
      details: { from: "agreed", source: "razorpay", paymentLinkId: linkId, paymentId: str(payment?.id), amountMinor: charge.amount_minor, currency: charge.currency },
    })
  } else if (charge.status === "void") {
    logger.error("A voided placement charge was paid by its link; refund it from the Razorpay dashboard", {
      chargeId: charge.id,
      paymentLinkId: linkId,
      paymentId: str(payment?.id),
    })
    out.audit.push({
      action: "charge.paid_after_void",
      orgId: c.org_id,
      resource,
      details: { paymentLinkId: linkId, paymentId: str(payment?.id), amountMinor: charge.amount_minor },
    })
  }
  // settled already (a replay under a new event id, or settled by hand): nothing more.
  await advance(tx, c, eventAt, "paid")
  return out
}

/** A full refund of a link's payment voids the charge it settled, with the refund as the reason. */
async function voidRefundedCharge(tx: Tx, out: Outcome, c: Checkout, refundId: string | null, eventAt: Date) {
  if (!c.charge_id) return
  const charge = await lockCharge(tx, c.charge_id)
  if (!charge || charge.status === "void") return
  await tx.placement_charges.update({
    where: { id: charge.id },
    data: { status: "void", voided_at: eventAt, voided_by: null, void_reason: `Refunded at Razorpay${refundId ? ` (${refundId})` : ""}` },
  })
  out.audit.push({
    action: "charge.void",
    orgId: c.org_id,
    resource: { kind: "placement_charges", id: charge.id },
    details: { from: charge.status, source: "razorpay", reason: "refund.processed", refundId, amountMinor: charge.amount_minor },
  })
}
