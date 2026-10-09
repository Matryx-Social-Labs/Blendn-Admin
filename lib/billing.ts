import "server-only"

import type { org_role, user_role } from "@prisma/client"

import { BILLING_PLANS, isBillingPlanKey, type BillingPlanKey } from "./billing-plans"
import { db } from "./db"
import { liveEntitlement, eventPassesFor, type LiveEntitlement } from "./entitlements"
import { razorpayKeys } from "./env"
import { realEventsWhere } from "./event-kind"
import { logger } from "./logger"
import { activeMembership, HOME_ORG_ORDER } from "./org-membership"
import { mayManageBilling } from "./rbac"

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
 * `mayManageBilling` (lib/rbac.ts): the organisation's owners and admins.
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
    mayBuy: mayManageBilling(user.role, membership.role),
  }
}

/** Whether checkout can run here: keys and the webhook secret set, keys in the right mode. */
export function paymentsOn(): boolean {
  try {
    return razorpayKeys() !== null
  } catch (err) {
    logger.error("Razorpay keys refused", { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * Razorpay's statuses for a subscription that could still charge. `created`
 * counts: an unpaid checkout is open until Razorpay expires it (`expire_by`),
 * and a second one beside it would be a second mandate. The partial unique
 * index `billing_checkouts_one_open_subscription_per_org` lists the same six.
 */
export const OPEN_SUBSCRIPTION_STATUSES = ["created", "authenticated", "active", "pending", "halted", "paused"] as const

/**
 * Which date to say. A running subscription "renews" on its paid-up date; a
 * grant, or a subscription set to end, is on "until" the row's end. The row's
 * end on a subscription includes the 3-day renewal grace, so it is never the
 * date to show while it renews.
 */
export interface PlanDate {
  word: "renews" | "until"
  at: Date
}

export interface PlanBadge {
  analytics: boolean
  date: PlanDate | null
  source: LiveEntitlement["source"] | null
}

async function liveSubscription(orgId: string) {
  return db.billing_checkouts.findFirst({
    where: { org_id: orgId, kind: "subscription", status: { in: [...OPEN_SUBSCRIPTION_STATUSES] } },
    orderBy: { created_at: "desc" },
    select: { provider_ref: true, plan_key: true, status: true, current_end: true, cancel_at_cycle_end: true, created_at: true },
  })
}

export function planDate(
  live: LiveEntitlement | null,
  sub: { status: string; current_end: Date | null; cancel_at_cycle_end: boolean } | null
): PlanDate | null {
  if (!live) return null
  if (live.source === "razorpay" && sub?.status === "active" && !sub.cancel_at_cycle_end && sub.current_end) {
    return { word: "renews", at: sub.current_end }
  }
  if (live.source === "razorpay" && sub?.cancel_at_cycle_end && sub.current_end) return { word: "until", at: sub.current_end }
  return live.expiresAt ? { word: "until", at: live.expiresAt } : null
}

export async function planBadgeFor(orgId: string, now: Date = new Date()): Promise<PlanBadge> {
  const [live, sub] = await Promise.all([liveEntitlement({ kind: "org", id: orgId }, "analytics", now), liveSubscription(orgId)])
  return { analytics: live !== null, date: planDate(live, sub), source: live?.source ?? null }
}

export interface SubscriptionState {
  providerRef: string
  planKey: BillingPlanKey
  status: string
  currentEnd: Date | null
  cancelAtCycleEnd: boolean
  createdAt: Date
}

export interface PaymentLine {
  id: string
  at: Date
  label: string
  amountMinor: number
  /** Razorpay's invoice id when it issued one, else the payment id. */
  reference: string
  status: string
}

export interface PlanPageData {
  org: BillingOrg
  paymentsOn: boolean
  analytics: LiveEntitlement | null
  date: PlanDate | null
  /** Every subscription that could still charge, newest first. Normally none or one. */
  subscriptions: SubscriptionState[]
  events: { id: string; title: string; startsAt: Date; hasPass: boolean }[]
  payments: PaymentLine[]
}

export async function planPageData(org: BillingOrg, now: Date = new Date()): Promise<PlanPageData> {
  const [analytics, subscriptionRows, events, paid] = await Promise.all([
    liveEntitlement({ kind: "org", id: org.orgId }, "analytics", now),
    db.billing_checkouts.findMany({
      where: { org_id: org.orgId, kind: "subscription", status: { in: [...OPEN_SUBSCRIPTION_STATUSES] } },
      orderBy: { created_at: "desc" },
      select: { provider_ref: true, plan_key: true, status: true, current_end: true, cancel_at_cycle_end: true, created_at: true },
    }),
    db.events.findMany({
      where: { organizer_org_id: org.orgId, deleted_at: null, ...realEventsWhere },
      orderBy: { start_time: "desc" },
      take: 50,
      select: { id: true, title: true, start_time: true },
    }),
    db.billing_payments.findMany({
      where: { checkout: { org_id: org.orgId } },
      orderBy: { captured_at: "desc" },
      take: 24,
      select: {
        id: true,
        captured_at: true,
        amount_minor: true,
        invoice_id: true,
        provider_payment_id: true,
        status: true,
        checkout: { select: { plan_key: true } },
      },
    }),
  ])
  const passes = await eventPassesFor(org.orgId, events.map((e) => e.id), now)
  const subscriptions = subscriptionRows.flatMap((s) =>
    isBillingPlanKey(s.plan_key)
      ? [
          {
            providerRef: s.provider_ref,
            planKey: s.plan_key,
            status: s.status,
            currentEnd: s.current_end,
            cancelAtCycleEnd: s.cancel_at_cycle_end,
            createdAt: s.created_at,
          },
        ]
      : []
  )

  return {
    org,
    paymentsOn: paymentsOn(),
    analytics,
    date: planDate(analytics, subscriptionRows[0] ?? null),
    subscriptions,
    events: events.map((e) => ({ id: e.id, title: e.title, startsAt: e.start_time, hasPass: passes.has(e.id) })),
    payments: paid.map((p) => ({
      id: p.id,
      at: p.captured_at,
      label: isBillingPlanKey(p.checkout.plan_key) ? BILLING_PLANS[p.checkout.plan_key].label : "Payment",
      amountMinor: p.amount_minor,
      reference: p.invoice_id ?? p.provider_payment_id,
      status: p.status,
    })),
  }
}
