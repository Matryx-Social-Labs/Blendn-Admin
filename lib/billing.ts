import type { org_role, user_role } from "@prisma/client"

import { BILLING_PLANS, isBillingPlanKey, type BillingPlanKey } from "./billing-plans"
import { db } from "./db"
import { analyticsAccess, mayOpenEvent, type AccessReason } from "./analytics-access"
import { liveEntitlement, type LiveEntitlement } from "./entitlements"
import { realEventsWhere } from "./event-kind"
import { logger } from "./logger"
import { activeMembership, HOME_ORG_ORDER } from "./org-membership"
import { razorpayConfig } from "./razorpay"

/**
 * What the Plan page and the sidebar read about an organisation's plan.
 *
 * ## Which organisation
 *
 * The home one: the oldest live membership, the same rule as `homeOrgIdFor`
 * and the sidebar's identity card. Analytics is sold per organisation, and an
 * organiser in two is shown, and buys for, the one the card names.
 *
 * ## Who may buy
 *
 * The organisation's owners and admins — the people who manage its members
 * (`orgPermissions`). Staff see the plan and are told who can change it.
 */

export interface BillingOrg {
  orgId: string
  orgName: string
  memberRole: org_role
  mayBuy: boolean
}

export async function billingOrgFor(user: { id: string; role: user_role }): Promise<BillingOrg | null> {
  if (user.role !== "organizer") return null
  const membership = await db.organisation_members.findFirst({
    where: { user_id: user.id, ...activeMembership },
    orderBy: HOME_ORG_ORDER,
    select: { role: true, org: { select: { id: true, display_name: true } } },
  })
  if (!membership) return null
  return {
    orgId: membership.org.id,
    orgName: membership.org.display_name,
    memberRole: membership.role,
    mayBuy: membership.role === "owner" || membership.role === "admin",
  }
}

/** Whether checkout can run here: keys set, and in the right mode. */
export function paymentsOn(): boolean {
  try {
    return razorpayConfig() !== null
  } catch (err) {
    logger.error("Razorpay keys refused", { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** The sidebar's plan card: free, or Analytics until a date. */
export interface PlanBadge {
  analytics: boolean
  until: Date | null
  source: LiveEntitlement["source"] | null
}

export async function planBadgeFor(orgId: string, now: Date = new Date()): Promise<PlanBadge> {
  const live = await liveEntitlement({ kind: "org", id: orgId }, "analytics", now)
  return { analytics: live !== null, until: live?.expiresAt ?? null, source: live?.source ?? null }
}

export interface SubscriptionState {
  providerRef: string
  planKey: BillingPlanKey
  status: string
  currentEnd: Date | null
  cancelAtCycleEnd: boolean
}

export interface PaymentLine {
  at: Date
  label: string
  amountMinor: number
  /** Razorpay's invoice id when it issued one, else the payment id. */
  reference: string | null
}

export interface PlanPageData {
  org: BillingOrg
  paymentsOn: boolean
  /** Whether the paywall has started, and the first event that cleared the floor (free for good). */
  free: { reason: AccessReason; until: Date | null; firstEventTitle: string | null }
  analytics: LiveEntitlement | null
  subscription: SubscriptionState | null
  /** Events whose pass features are still locked: the ones an Event Pass would open. */
  events: { id: string; title: string; startsAt: Date }[]
  payments: PaymentLine[]
}

/** Statuses of a subscription that is running or could still charge. */
export const OPEN_SUBSCRIPTION_STATUSES = ["authenticated", "active", "pending", "halted"]

export async function planPageData(org: BillingOrg, now: Date = new Date()): Promise<PlanPageData> {
  const [access, analytics, subscriptionRow, events, paid] = await Promise.all([
    analyticsAccess(org.orgId, now),
    liveEntitlement({ kind: "org", id: org.orgId }, "analytics", now),
    db.billing_checkouts.findFirst({
      where: { org_id: org.orgId, kind: "subscription", status: { in: OPEN_SUBSCRIPTION_STATUSES } },
      orderBy: { created_at: "desc" },
      select: { provider_ref: true, plan_key: true, status: true, current_end: true, cancel_at_cycle_end: true },
    }),
    db.events.findMany({
      where: { organizer_org_id: org.orgId, deleted_at: null, ...realEventsWhere },
      orderBy: { start_time: "desc" },
      take: 50,
      select: { id: true, title: true, start_time: true },
    }),
    db.payment_events.findMany({
      where: {
        checkout: { org_id: org.orgId },
        type: { in: ["subscription.charged", "order.paid"] },
        processed_at: { not: null },
      },
      orderBy: { received_at: "desc" },
      take: 24,
      select: { received_at: true, payload: true, checkout: { select: { plan_key: true } } },
    }),
  ])
  const firstFree = access.firstFreeEventId ? events.find((e) => e.id === access.firstFreeEventId) : undefined

  return {
    org,
    paymentsOn: paymentsOn(),
    free: { reason: access.reason, until: access.freeUntil, firstEventTitle: firstFree?.title ?? null },
    analytics,
    subscription:
      subscriptionRow && isBillingPlanKey(subscriptionRow.plan_key)
        ? {
            providerRef: subscriptionRow.provider_ref,
            planKey: subscriptionRow.plan_key,
            status: subscriptionRow.status,
            currentEnd: subscriptionRow.current_end,
            cancelAtCycleEnd: subscriptionRow.cancel_at_cycle_end,
          }
        : null,
    events: events
      .filter((e) => !mayOpenEvent(access, e.id))
      .map((e) => ({ id: e.id, title: e.title, startsAt: e.start_time })),
    payments: paid.map((p) => paymentLine(p.received_at, p.payload, p.checkout?.plan_key ?? null)),
  }
}

/** One processed charge, read back from the delivery Razorpay signed. */
function paymentLine(at: Date, payload: unknown, planKey: string | null): PaymentLine {
  const body = (payload ?? {}) as { payload?: Record<string, { entity?: Record<string, unknown> }> }
  const payment = body.payload?.payment?.entity ?? {}
  const order = body.payload?.order?.entity ?? {}
  const amount = typeof payment.amount === "number" ? payment.amount : typeof order.amount === "number" ? order.amount : 0
  const invoice = typeof payment.invoice_id === "string" ? payment.invoice_id : null
  const paymentId = typeof payment.id === "string" ? payment.id : null
  return {
    at,
    label: planKey && isBillingPlanKey(planKey) ? BILLING_PLANS[planKey].label : "Payment",
    amountMinor: amount,
    reference: invoice ?? paymentId,
  }
}
