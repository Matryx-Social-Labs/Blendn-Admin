"use server"

import { revalidatePath } from "next/cache"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { billingOrgFor, OPEN_SUBSCRIPTION_STATUSES } from "@/lib/billing"
import { BILLING_PLANS, chargeMinor } from "@/lib/billing-plans"
import { db } from "@/lib/db"
import { analyticsAccess, mayOpenEvent } from "@/lib/analytics-access"
import { endGrant, grantEntitlement, liveEntitlement } from "@/lib/entitlements"
import { realEventsWhere } from "@/lib/event-kind"
import { logger } from "@/lib/logger"
import {
  cancelSubscription,
  createEventPassOrder,
  createSubscription,
  planIdFor,
  RazorpayError,
  razorpayConfig,
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
 * cancels for that organisation; a platform admin grants.
 */

const PAYMENTS_OFF = "Payments aren't switched on here yet."

/** The caller's home organisation, if they may buy for it. */
async function requireBuyer() {
  const session = await getAuth()
  if (!session?.user) throw new Refusal("Unauthorized")
  const org = await billingOrgFor({ id: session.user.id, role: session.user.role })
  if (!org) throw new Refusal("Only an organiser's organisation has a plan.")
  if (!org.mayBuy) throw new Refusal("Only an owner or admin of your organisation can change its plan.")
  const config = (() => {
    try {
      return razorpayConfig()
    } catch {
      return null
    }
  })()
  if (!config) throw new Refusal(PAYMENTS_OFF)
  return { user: session.user, org, keyId: config.keyId }
}

/** Razorpay's failure, as a sentence for the person who clicked. */
function providerRefusal(err: unknown, what: string): never {
  if (err instanceof Refusal) throw err
  logger.error(`Razorpay ${what} failed`, {
    status: err instanceof RazorpayError ? err.status : undefined,
    error: err instanceof Error ? err.message : String(err),
  })
  throw new Refusal("Razorpay didn't accept that just now. Nothing was charged; try again in a minute.")
}

export interface SubscriptionCheckout {
  kind: "subscription"
  keyId: string
  subscriptionId: string
}

/** Start an Analytics subscription for the caller's organisation. */
export async function startAnalyticsCheckout(
  period: "monthly" | "yearly"
): Promise<SubscriptionCheckout> {
  const { user, org, keyId } = await requireBuyer()
  if (period !== "monthly" && period !== "yearly") throw new Refusal("Choose monthly or yearly.")
  const plan = BILLING_PLANS[period === "monthly" ? "analytics_monthly" : "analytics_yearly"]

  const running = await db.billing_checkouts.findFirst({
    where: { org_id: org.orgId, kind: "subscription", status: { in: OPEN_SUBSCRIPTION_STATUSES } },
    select: { id: true },
  })
  if (running) throw new Refusal("Your organisation already has an Analytics subscription. Manage it below.")

  try {
    const planId = await planIdFor(plan)
    if (!planId) {
      logger.error("No Razorpay plan matches the price table; run scripts/razorpay-plans.ts --apply", { plan: plan.key })
      throw new Refusal(PAYMENTS_OFF)
    }
    const sub = await createSubscription({ planId, totalCount: plan.totalCount ?? 1, orgId: org.orgId })
    await db.billing_checkouts.create({
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
    auditLog({
      userId: user.id,
      action: "billing.checkout.started",
      resource: "organisation",
      resourceId: org.orgId,
      details: { plan: plan.key, providerRef: sub.id },
    })
    return { kind: "subscription", keyId, subscriptionId: sub.id }
  } catch (err) {
    providerRefusal(err, "subscription create")
  }
}

export interface OrderCheckout {
  kind: "order"
  keyId: string
  orderId: string
  amountMinor: number
}

/** Start an Event Pass purchase for one of the organisation's events. */
export async function startEventPassCheckout(eventId: string): Promise<OrderCheckout> {
  const { user, org, keyId } = await requireBuyer()

  // findFirst, not by id alone: an event of another organisation is "not
  // found", the same answer as one that does not exist.
  const event = await db.events.findFirst({
    where: { id: eventId, organizer_org_id: org.orgId, deleted_at: null, ...realEventsWhere },
    select: { id: true },
  })
  if (!event) throw new Refusal("That event isn't one of your organisation's.")
  // Nothing to sell when it is already open: Analytics, the free window, the
  // first event that cleared the floor, or a pass already bought.
  const access = await analyticsAccess(org.orgId)
  if (access.org) {
    throw new Refusal(
      access.reason === "free_window"
        ? "Every event's analytics are free for now, so there's nothing to buy yet."
        : "Analytics already covers every event your organisation runs."
    )
  }
  if (mayOpenEvent(access, eventId)) throw new Refusal("That event's analytics are already open to you.")

  const plan = BILLING_PLANS.event_pass
  try {
    const order = await createEventPassOrder({
      orgId: org.orgId,
      eventId,
      receipt: `pass-${eventId.slice(0, 8)}-${Date.now().toString(36)}`,
    })
    await db.billing_checkouts.create({
      data: {
        kind: "order",
        provider_ref: order.id,
        org_id: org.orgId,
        event_id: eventId,
        plan_key: plan.key,
        amount_minor: chargeMinor(plan),
        status: order.status || "created",
        created_by: user.id,
      },
    })
    auditLog({
      userId: user.id,
      action: "billing.checkout.started",
      resource: "organisation",
      resourceId: org.orgId,
      details: { plan: plan.key, providerRef: order.id, eventId },
    })
    return { kind: "order", keyId, orderId: order.id, amountMinor: chargeMinor(plan) }
  } catch (err) {
    providerRefusal(err, "order create")
  }
}

/**
 * Stop the subscription. A running one stops renewing and Analytics lasts to
 * the end of what was paid for; a halted one ends now. Either way the
 * entitlement moves only when Razorpay's `subscription.cancelled` arrives.
 */
export async function cancelAnalytics(): Promise<void> {
  const { user, org } = await requireBuyer()
  const sub = await db.billing_checkouts.findFirst({
    where: { org_id: org.orgId, kind: "subscription", status: { in: OPEN_SUBSCRIPTION_STATUSES } },
    orderBy: { created_at: "desc" },
    select: { id: true, provider_ref: true, status: true, cancel_at_cycle_end: true },
  })
  if (!sub) throw new Refusal("There's no subscription to cancel.")
  if (sub.cancel_at_cycle_end) throw new Refusal("It's already set to end at the close of this cycle.")

  const atCycleEnd = sub.status === "active"
  try {
    await cancelSubscription(sub.provider_ref, atCycleEnd)
  } catch (err) {
    providerRefusal(err, "subscription cancel")
  }
  await db.billing_checkouts.update({ where: { id: sub.id }, data: { cancel_at_cycle_end: true } })
  auditLog({
    userId: user.id,
    action: "billing.subscription.cancelled",
    resource: "organisation",
    resourceId: org.orgId,
    details: { providerRef: sub.provider_ref, atCycleEnd },
  })
  revalidatePath("/dashboard/plan")
}

/* -------------------------------------------------------------------------- */
/* Platform admin: founding grants                                             */
/* -------------------------------------------------------------------------- */

async function requireAdmin() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Refusal("Forbidden")
  return session.user
}

/** The founding grant is six months (plan v2 §9.1b); an admin may choose 1–24. */
const MAX_GRANT_MONTHS = 24

export async function grantAnalytics(orgId: string, months: number, reason: string): Promise<{ expiresAt: string }> {
  const admin = await requireAdmin()
  if (!Number.isInteger(months) || months < 1 || months > MAX_GRANT_MONTHS) {
    throw new Refusal(`A grant runs between 1 and ${MAX_GRANT_MONTHS} months.`)
  }
  if (reason.trim().length < 10) throw new Refusal("Record why this organisation is being given Analytics.")

  const org = await db.organisations.findUnique({ where: { id: orgId }, select: { id: true, status: true, display_name: true } })
  if (!org) throw new Refusal("Organisation not found")
  if (org.status === "suspended") throw new Refusal("A suspended organisation can't be granted Analytics.")

  const live = await liveEntitlement({ kind: "org", id: orgId }, "analytics")
  if (live?.source === "grant") {
    throw new Refusal("This organisation already has a grant. End it before giving a new one.")
  }

  const grant = await grantEntitlement({ subject: { kind: "org", id: orgId }, product: "analytics", months })
  auditLog({
    userId: admin.id,
    action: "entitlement.granted",
    resource: "organisation",
    resourceId: orgId,
    details: {
      product: "analytics",
      months,
      expiresAt: grant.expiresAt.toISOString(),
      reason: reason.trim(),
      orgName: org.display_name,
    },
  })
  revalidatePath("/dashboard/organisations")
  return { expiresAt: grant.expiresAt.toISOString() }
}

export async function endAnalyticsGrant(orgId: string, entitlementId: string, reason: string): Promise<void> {
  const admin = await requireAdmin()
  if (reason.trim().length < 10) throw new Refusal("Give a reason for ending this grant.")
  const ended = await endGrant({ kind: "org", id: orgId }, entitlementId)
  if (!ended) throw new Refusal("That grant has already ended.")
  auditLog({
    userId: admin.id,
    action: "entitlement.grant_ended",
    resource: "organisation",
    resourceId: orgId,
    details: { product: ended.product, entitlementId, reason: reason.trim() },
  })
  revalidatePath("/dashboard/organisations")
}
