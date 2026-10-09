import "server-only"

import type { user_role } from "@prisma/client"

import { OPEN_SUBSCRIPTION_STATUSES, paymentsOn, planDate, type PaymentLine, type PlanDate, type SubscriptionState } from "./billing"
import { BILLING_PLANS, isBillingPlanKey } from "./billing-plans"
import { db } from "./db"
import { liveEntitlement, type LiveEntitlement } from "./entitlements"
import { activeMembership } from "./org-membership"
import { mayManageVenueBilling } from "./rbac"

/**
 * A venue's plan: Listed (free) or Venue Pro (plan v2 §9.1b, audit §6.2).
 *
 * ## No charge before four weeks of venue-day data
 *
 * The owner ruled it: nothing is charged until venue days are live AND the
 * venue has at least four weeks of data. Venue days are the venue's own live
 * room (lib/venue-day.ts); "data" starts with the first person who went live
 * there. So a venue becomes chargeable 28 days after its first venue-day
 * check-in, and before that the Plan page says when, and the checkout action
 * refuses (`lib/billing-actions.ts`). A founding grant (3 months of Pro) is
 * not a charge and is open at any time.
 */

export const VENUE_DATA_DAYS = 28
const DAY_MS = 24 * 60 * 60 * 1000

export interface VenueReadiness {
  /** The first check-in to the venue's live room; null while nobody has gone live there. */
  dataSince: Date | null
  /** When charging may start; null while there is no data at all. */
  chargeableFrom: Date | null
  /** Whole days of data, at most `VENUE_DATA_DAYS`: the meter on the Plan page. */
  dataDays: number
  chargeable: boolean
}

export function readinessFrom(dataSince: Date | null, now: Date = new Date()): VenueReadiness {
  if (!dataSince) return { dataSince: null, chargeableFrom: null, dataDays: 0, chargeable: false }
  const chargeableFrom = new Date(dataSince.getTime() + VENUE_DATA_DAYS * DAY_MS)
  const dataDays = Math.min(VENUE_DATA_DAYS, Math.max(0, Math.floor((now.getTime() - dataSince.getTime()) / DAY_MS)))
  return { dataSince, chargeableFrom, dataDays, chargeable: now >= chargeableFrom }
}

/** When each venue's live-room data starts: its first venue-day check-in. */
export async function venueDataSince(venueIds: string[]): Promise<Map<string, Date>> {
  if (venueIds.length === 0) return new Map()
  const rows = await db.$queryRaw<{ venue_id: string; first: Date }[]>`
    SELECT e.venue_id::text AS venue_id, min(c.check_in_time) AS first
      FROM event_check_ins c
      JOIN events e ON e.id = c.event_id
     WHERE e.kind = 'venue_day' AND e.venue_id = ANY(${venueIds}::uuid[])
     GROUP BY e.venue_id`
  return new Map(rows.map((r) => [r.venue_id, r.first]))
}

export async function venueReadiness(venueId: string, now: Date = new Date()): Promise<VenueReadiness> {
  return readinessFrom((await venueDataSince([venueId])).get(venueId) ?? null, now)
}

export interface VenuePlanRow {
  venueId: string
  name: string
  city: string | null
  orgName: string
  /** The owner or an admin of the venue's organisation. */
  mayBuy: boolean
  pro: LiveEntitlement | null
  date: PlanDate | null
  readiness: VenueReadiness
  /** Every Venue Pro subscription that could still charge for this venue. */
  subscriptions: SubscriptionState[]
}

export interface VenuePlanPage {
  paymentsOn: boolean
  venues: VenuePlanRow[]
  payments: (PaymentLine & { venueName: string })[]
}

/**
 * The venues this person's organisations own, each with its plan. A venue is
 * owned through its organisation (`owner_org_id`), never `owner_id`.
 */
export async function venuePlanPage(user: { id: string; role: user_role }, now: Date = new Date()): Promise<VenuePlanPage> {
  if (user.role !== "venue_owner") return { paymentsOn: paymentsOn(), venues: [], payments: [] }
  const memberships = await db.organisation_members.findMany({
    where: { user_id: user.id, ...activeMembership },
    select: { org_id: true, role: true },
  })
  const roleIn = new Map(memberships.map((m) => [m.org_id, m.role]))
  const venues = await db.venues.findMany({
    where: { owner_org_id: { in: [...roleIn.keys()] }, deleted_at: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true, city: true, owner_org_id: true, owner_org: { select: { display_name: true } } },
  })
  const ids = venues.map((v) => v.id)
  const [since, subs, paid, pros] = await Promise.all([
    venueDataSince(ids),
    ids.length
      ? db.billing_checkouts.findMany({
          where: { venue_id: { in: ids }, kind: "subscription", status: { in: [...OPEN_SUBSCRIPTION_STATUSES] } },
          orderBy: { created_at: "desc" },
          select: { venue_id: true, provider_ref: true, plan_key: true, status: true, current_end: true, cancel_at_cycle_end: true, created_at: true },
        })
      : [],
    ids.length
      ? db.billing_payments.findMany({
          where: { checkout: { venue_id: { in: ids } } },
          orderBy: { captured_at: "desc" },
          take: 24,
          select: {
            id: true,
            captured_at: true,
            amount_minor: true,
            invoice_id: true,
            provider_payment_id: true,
            status: true,
            checkout: { select: { plan_key: true, venue: { select: { name: true } } } },
          },
        })
      : [],
    Promise.all(ids.map((id) => liveEntitlement({ kind: "venue", id }, "venue_pro", now))),
  ])

  return {
    paymentsOn: paymentsOn(),
    venues: venues.map((v, i) => {
      const mine = subs.filter((s) => s.venue_id === v.id)
      const subscriptions = mine.flatMap((s) =>
        isBillingPlanKey(s.plan_key)
          ? [{ providerRef: s.provider_ref, planKey: s.plan_key, status: s.status, currentEnd: s.current_end, cancelAtCycleEnd: s.cancel_at_cycle_end, createdAt: s.created_at }]
          : []
      )
      const memberRole = v.owner_org_id ? roleIn.get(v.owner_org_id) : undefined
      return {
        venueId: v.id,
        name: v.name,
        city: v.city,
        orgName: v.owner_org?.display_name ?? "",
        mayBuy: memberRole ? mayManageVenueBilling(user.role, memberRole) : false,
        pro: pros[i],
        date: planDate(pros[i], mine[0] ?? null),
        readiness: readinessFrom(since.get(v.id) ?? null, now),
        subscriptions,
      }
    }),
    payments: paid.map((p) => ({
      id: p.id,
      at: p.captured_at,
      label: isBillingPlanKey(p.checkout.plan_key) ? BILLING_PLANS[p.checkout.plan_key].label : "Payment",
      amountMinor: p.amount_minor,
      reference: p.invoice_id ?? p.provider_payment_id,
      status: p.status,
      venueName: p.checkout.venue?.name ?? "",
    })),
  }
}
