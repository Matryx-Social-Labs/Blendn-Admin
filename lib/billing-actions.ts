"use server"

import { revalidatePath } from "next/cache"
import type { Prisma } from "@prisma/client"
import { z } from "zod"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { billingOrgFor, OPEN_SUBSCRIPTION_STATUSES } from "@/lib/billing"
import { BILLING_PLANS, chargeMinor } from "@/lib/billing-plans"
import { db } from "@/lib/db"
import { endGrants, grantEntitlement, hasEntitlement, liveGrant, revokePaid } from "@/lib/entitlements"
import { razorpayKeys } from "@/lib/env"
import { realEventsWhere } from "@/lib/event-kind"
import { logger } from "@/lib/logger"
import { violatedConstraint } from "@/lib/prisma-errors"
import { hit } from "@/lib/rate-limit-store"
import {
  cancelSubscription,
  CREATED_CHECKOUT_LIFETIME_MS,
  createEventPassOrder,
  createSubscription,
  planIdFor,
  RazorpayError,
} from "@/lib/razorpay"
import { Refusal } from "@/lib/refusal"

/**
 * Starting, stopping and granting a plan (plan v2 §9.2).
 *
 * None of these grants anything paid. Starting a purchase writes our record
 * of it (`billing_checkouts`) and hands the browser an id for Razorpay's
 * Checkout; the entitlement arrives later, from the signed webhook. A browser
 * that claims "paid" on its way back changes nothing.
 *
 * Each action authorises itself: an organisation's owner or admin buys and
 * cancels for that organisation; a platform admin grants and revokes.
 *
 * ## One open purchase per organisation
 *
 * Two admins, two tabs or a double click must not open two mandates. Starting
 * takes a transaction-scoped advisory lock on the organisation, resumes a
 * checkout opened in the last 30 minutes for the same thing, marks older
 * unpaid ones expired, and only then creates. The partial unique index
 * `billing_checkouts_one_open_subscription_per_org` holds if two requests
 * race past the lock anyway.
 */

const PAYMENTS_OFF = "Payments aren't switched on here yet."
const OPEN_ONE = "billing_checkouts_one_open_subscription_per_org"
const STARTS = { max: 5, windowMs: 60_000 }
/** The lock is held across one Razorpay call (≤15 s), so the transaction may run that long. */
const TX = { maxWait: 10_000, timeout: 30_000 }

const periodSchema = z.enum(["monthly", "yearly"])
const idSchema = z.uuid()
const reasonSchema = z.string().trim().min(10).max(500)
const monthsSchema = z.number().int().min(1).max(24)

function parse<T>(schema: z.ZodType<T>, value: unknown, sentence: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Refusal(sentence)
  return parsed.data
}

/** The caller's home organisation, if they may buy for it, with payments on and under the rate. */
async function requireBuyer() {
  const session = await getAuth()
  if (!session?.user) throw new Refusal("Unauthorized")
  const org = await billingOrgFor({ id: session.user.id, role: session.user.role })
  if (!org) throw new Refusal("Only an organiser's organisation has a plan.")
  if (!org.mayBuy) throw new Refusal("Only an owner or admin of your organisation can change its plan.")
  let keys: ReturnType<typeof razorpayKeys> = null
  try {
    keys = razorpayKeys()
  } catch (err) {
    logger.error("Razorpay keys refused", { error: err instanceof Error ? err.message : String(err) })
  }
  if (!keys) throw new Refusal(PAYMENTS_OFF)
  const { count } = await hit(`billing:start:${org.orgId}`, STARTS.windowMs)
  if (count > STARTS.max) throw new Refusal("Too many tries in a minute. Wait a moment and try again.")
  return { user: session.user, org, keyId: keys.keyId }
}

/** The organisation's purchases, one at a time, until the transaction ends. */
async function lockOrg(tx: Prisma.TransactionClient, scope: string, orgId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${orgId}`}, 0))`
}

/**
 * A failure while starting: a Refusal stands; otherwise say whose it was. A
 * Razorpay failure means nothing was charged; a database failure after
 * Razorpay answered leaves an id at Razorpay with no row here, which is logged
 * so an operator can find it.
 */
function startFailure(err: unknown, what: string, orphan: string | null): never {
  if (err instanceof Refusal) throw err
  if (err instanceof RazorpayError) {
    logger.error(`Razorpay ${what} failed`, { status: err.status, error: err.message })
    throw new Refusal("Razorpay didn't accept that just now. Try again in a minute.")
  }
  logger.error(`Saving the ${what} failed`, {
    error: err instanceof Error ? err.message : String(err),
    orphanProviderRef: orphan,
  })
  throw new Refusal("Something went wrong on our side. Nothing was started; try again in a minute.")
}

export interface SubscriptionCheckout {
  kind: "subscription"
  keyId: string
  subscriptionId: string
}

/** Start (or resume) an Analytics subscription for the caller's organisation. */
export async function startAnalyticsCheckout(period: "monthly" | "yearly"): Promise<SubscriptionCheckout> {
  const chosen = parse(periodSchema, period, "Choose monthly or yearly.")
  const { user, org, keyId } = await requireBuyer()
  const plan = BILLING_PLANS[chosen === "monthly" ? "analytics_monthly" : "analytics_yearly"]
  let orphan: string | null = null
  try {
    const subscriptionId = await db.$transaction(async (tx) => {
      await lockOrg(tx, "billing", org.orgId)
      const now = new Date()
      const open = await tx.billing_checkouts.findMany({
        where: { org_id: org.orgId, kind: "subscription", status: { in: [...OPEN_SUBSCRIPTION_STATUSES] } },
        orderBy: { created_at: "desc" },
        select: { id: true, provider_ref: true, plan_key: true, status: true, created_at: true },
      })
      if (open.some((s) => s.status !== "created")) {
        throw new Refusal("Your organisation already has an Analytics subscription. Manage it below.")
      }
      const fresh = open.find((s) => s.plan_key === plan.key && now.getTime() - s.created_at.getTime() < CREATED_CHECKOUT_LIFETIME_MS)
      if (fresh) return fresh.provider_ref
      // Unpaid and either stale or for the other period: Razorpay expires
      // them (expire_by); here they stop counting as open.
      if (open.length) {
        await tx.billing_checkouts.updateMany({ where: { id: { in: open.map((s) => s.id) } }, data: { status: "expired" } })
      }

      const planId = await planIdFor(plan)
      if (!planId) {
        logger.error("No Razorpay plan matches the price table; run scripts/razorpay-plans.ts --apply", { plan: plan.key })
        throw new Refusal(PAYMENTS_OFF)
      }
      const sub = await createSubscription({ planId, totalCount: plan.totalCount ?? 1, orgId: org.orgId, now })
      orphan = sub.id
      await tx.billing_checkouts.create({
        data: {
          kind: "subscription",
          provider_ref: sub.id,
          provider_plan_id: planId,
          org_id: org.orgId,
          plan_key: plan.key,
          amount_minor: chargeMinor(plan),
          status: sub.status || "created",
          created_by: user.id,
        },
      })
      return sub.id
    }, TX)
    auditLog({
      userId: user.id,
      action: "billing.checkout.started",
      resource: "organisation",
      resourceId: org.orgId,
      details: { plan: plan.key, providerRef: subscriptionId },
    })
    return { kind: "subscription", keyId, subscriptionId }
  } catch (err) {
    if (violatedConstraint(err, OPEN_ONE)) {
      // A race past the lock: Razorpay's subscription is left to expire_by.
      logger.warn("A second subscription start lost the race to the open one", { orgId: org.orgId, orphanProviderRef: orphan })
      throw new Refusal("Your organisation already has an Analytics subscription. Manage it below.")
    }
    startFailure(err, "subscription", orphan)
  }
}

export interface OrderCheckout {
  kind: "order"
  keyId: string
  orderId: string
  amountMinor: number
}

/** Start (or resume) an Event Pass purchase for one of the organisation's events. */
export async function startEventPassCheckout(eventId: string): Promise<OrderCheckout> {
  const id = parse(idSchema, eventId, "That event isn't one of your organisation's.")
  const { user, org, keyId } = await requireBuyer()
  const subject = { kind: "org" as const, id: org.orgId }
  const plan = BILLING_PLANS.event_pass
  let orphan: string | null = null
  try {
    const order = await db.$transaction(async (tx) => {
      await lockOrg(tx, "billing", org.orgId)
      // findFirst, not by id alone: an event of another organisation is "not
      // found", the same answer as one that does not exist.
      const event = await tx.events.findFirst({
        where: { id, organizer_org_id: org.orgId, deleted_at: null, ...realEventsWhere },
        select: { id: true },
      })
      if (!event) throw new Refusal("That event isn't one of your organisation's.")
      if (await hasEntitlement(subject, "analytics")) {
        throw new Refusal("Analytics already covers every event your organisation runs.")
      }
      if (await hasEntitlement(subject, "event_pass", { eventId: id })) {
        throw new Refusal("That event already has an Event Pass.")
      }
      // An unpaid order for this event is the one to pay: never a second.
      const open = await tx.billing_checkouts.findFirst({
        where: { org_id: org.orgId, kind: "order", event_id: id, status: "created" },
        orderBy: { created_at: "desc" },
        select: { provider_ref: true, amount_minor: true },
      })
      if (open) return { orderId: open.provider_ref, amountMinor: open.amount_minor }

      const created = await createEventPassOrder({
        orgId: org.orgId,
        eventId: id,
        receipt: `pass-${id.slice(0, 8)}-${Date.now().toString(36)}`,
      })
      orphan = created.id
      await tx.billing_checkouts.create({
        data: {
          kind: "order",
          provider_ref: created.id,
          org_id: org.orgId,
          event_id: id,
          plan_key: plan.key,
          amount_minor: chargeMinor(plan),
          status: created.status || "created",
          created_by: user.id,
        },
      })
      return { orderId: created.id, amountMinor: chargeMinor(plan) }
    }, TX)
    auditLog({
      userId: user.id,
      action: "billing.checkout.started",
      resource: "organisation",
      resourceId: org.orgId,
      details: { plan: plan.key, providerRef: order.orderId, eventId: id },
    })
    return { kind: "order", keyId, ...order }
  } catch (err) {
    startFailure(err, "order", orphan)
  }
}

/**
 * Stop every subscription that could still charge. A running one stops
 * renewing and Analytics lasts to the end of what was paid for; any other ends
 * now. The entitlement moves only when Razorpay's `subscription.cancelled`
 * arrives.
 */
export async function cancelAnalytics(): Promise<void> {
  const { user, org } = await requireBuyer()
  const open = await db.billing_checkouts.findMany({
    where: { org_id: org.orgId, kind: "subscription", status: { in: [...OPEN_SUBSCRIPTION_STATUSES] }, cancel_at_cycle_end: false },
    select: { id: true, provider_ref: true, status: true },
  })
  if (open.length === 0) throw new Refusal("There's no subscription to cancel, or it's already set to end.")
  for (const sub of open) {
    const atCycleEnd = sub.status === "active"
    try {
      await cancelSubscription(sub.provider_ref, atCycleEnd)
    } catch (err) {
      startFailure(err, "subscription cancel", null)
    }
    await db.billing_checkouts.update({
      where: { id: sub.id },
      data: atCycleEnd ? { cancel_at_cycle_end: true } : { cancel_at_cycle_end: true, status: sub.status === "created" ? "expired" : sub.status },
    })
    auditLog({
      userId: user.id,
      action: "billing.subscription.cancelled",
      resource: "organisation",
      resourceId: org.orgId,
      details: { providerRef: sub.provider_ref, atCycleEnd },
    })
  }
  revalidatePath("/dashboard/plan")
}

/* -------------------------------------------------------------------------- */
/* Platform admin: founding grants and revocations                             */
/* -------------------------------------------------------------------------- */

async function requireAdmin() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Refusal("Forbidden")
  return session.user
}

/** The founding grant is six months (plan v2 §9.1b); an admin may choose 1–24. */
export async function grantAnalytics(orgId: string, months: number, reason: string): Promise<{ expiresAt: string }> {
  const admin = await requireAdmin()
  const id = parse(idSchema, orgId, "Organisation not found")
  const length = parse(monthsSchema, months, "A grant runs between 1 and 24 months.")
  const why = parse(reasonSchema, reason, "Record why this organisation is being given Analytics (10 to 500 characters).")

  const org = await db.organisations.findUnique({ where: { id }, select: { id: true, status: true, display_name: true } })
  if (!org) throw new Refusal("Organisation not found")
  if (org.status === "suspended") throw new Refusal("A suspended organisation can't be granted Analytics.")

  const grant = await db.$transaction(async (tx) => {
    // One live grant per organisation: the check and the insert are one decision.
    await lockOrg(tx, "grant", id)
    if (await liveGrant({ kind: "org", id }, "analytics", new Date(), tx)) {
      throw new Refusal("This organisation already has a grant. End it before giving a new one.")
    }
    const made = await grantEntitlement(tx, { subject: { kind: "org", id }, product: "analytics", months: length })
    await tx.audit_logs.create({
      data: {
        user_id: admin.id,
        action: "entitlement.granted",
        resource: "organisation",
        resource_id: id,
        details: { product: "analytics", months: length, expiresAt: made.expiresAt.toISOString(), reason: why, orgName: org.display_name },
      },
    })
    return made
  })
  revalidatePath("/dashboard/organisations")
  return { expiresAt: grant.expiresAt.toISOString() }
}

/** End every live Analytics grant on the organisation, now. */
export async function endAnalyticsGrant(orgId: string, reason: string): Promise<void> {
  const admin = await requireAdmin()
  const id = parse(idSchema, orgId, "Organisation not found")
  const why = parse(reasonSchema, reason, "Give a reason for ending this grant (10 to 500 characters).")
  const ended = await endGrants({ kind: "org", id }, "analytics")
  if (ended === 0) throw new Refusal("That grant has already ended.")
  auditLog({
    userId: admin.id,
    action: "entitlement.grant_ended",
    resource: "organisation",
    resourceId: id,
    details: { product: "analytics", ended, reason: why },
  })
  revalidatePath("/dashboard/organisations")
}

/**
 * End a live PAID entitlement now: a refund made outside Razorpay's webhook,
 * or a mistake. Does not cancel anything at Razorpay; the admin does that in
 * Razorpay's dashboard, and the reason says so.
 */
export async function revokePaidEntitlement(orgId: string, entitlementId: string, reason: string): Promise<void> {
  const admin = await requireAdmin()
  const id = parse(idSchema, orgId, "Organisation not found")
  const ent = parse(idSchema, entitlementId, "That entitlement isn't live.")
  const why = parse(reasonSchema, reason, "Give a reason for revoking it (10 to 500 characters).")
  const revoked = await revokePaid({ kind: "org", id }, ent)
  if (!revoked) throw new Refusal("That entitlement isn't live, or isn't a paid one.")
  auditLog({
    userId: admin.id,
    action: "entitlement.revoked",
    resource: "organisation",
    resourceId: id,
    details: { product: revoked.product, externalRef: revoked.externalRef, entitlementId: revoked.id, reason: why },
  })
  revalidatePath("/dashboard/organisations")
}
