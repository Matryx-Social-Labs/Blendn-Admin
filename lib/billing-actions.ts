"use server"

import { revalidatePath } from "next/cache"
import type { Prisma } from "@prisma/client"
import { z } from "zod"

import { analyticsAccess, mayOpenEvent } from "@/lib/analytics-access"
import { billingOrgFor, ONE_OPEN_PER_ORG, ONE_OPEN_PER_VENUE, OPEN_SUBSCRIPTION_STATUSES } from "@/lib/billing"
import { BILLING_PLANS, chargeMinor, type BillingPlanKey } from "@/lib/billing-plans"
import { currentUser, requireAdmin } from "@/lib/current-user"
import { db } from "@/lib/db"
import { endGrants, grantEntitlement, hasEntitlement, liveEntitlement, liveGrant, revokePaid } from "@/lib/entitlements"
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
import { activeMembership } from "@/lib/org-membership"
import { mayManageVenueBilling } from "@/lib/rbac"
import { Refusal } from "@/lib/refusal"
import { cancelThenRecord } from "@/lib/subscription-cancel"
import { venueReadiness } from "@/lib/venue-plan"

/**
 * Starting, stopping and granting a plan (plan v2 §9.2).
 *
 * None of these grants anything paid. Starting a purchase writes our record
 * of it (`billing_checkouts`) and hands the browser an id for Razorpay's
 * Checkout; the entitlement arrives later, from the signed webhook. A browser
 * that claims "paid" on its way back changes nothing.
 *
 * Each action authorises itself, on the role the database holds now
 * (`currentUser`), never the session's claim: an organisation's owner or
 * admin buys and cancels for that organisation; a platform admin grants and
 * revokes. Every state change is written with its audit row in one
 * transaction, and an end at Razorpay is recorded only once Razorpay has
 * confirmed it (`lib/subscription-cancel.ts`).
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
const STARTS = { max: 5, windowMs: 60_000 }
/** The lock is held across one Razorpay call (≤15 s), so the transaction may run that long. */
const TX = { maxWait: 10_000, timeout: 30_000 }

const periodSchema = z.enum(["monthly", "yearly"])
const idSchema = z.uuid()
const reasonSchema = z.string().trim().min(10).max(500)
const monthsSchema = z.number().int().min(1).max(24)
/** Dates in a refusal, on India's clock. */
const GRANT_DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })

function parse<T>(schema: z.ZodType<T>, value: unknown, sentence: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Refusal(sentence)
  return parsed.data
}

/** The caller's home organisation, if they may buy for it, with payments on and under the rate. */
async function requireBuyer() {
  const user = await currentUser()
  if (!user) throw new Refusal("Unauthorized")
  const org = await billingOrgFor(user)
  if (!org) throw new Refusal("Only an organiser's organisation has a plan.")
  if (!org.mayBuy) throw new Refusal("Only an owner or admin of your organisation can change its plan.")
  return { user, org, keyId: await payable(org.orgId) }
}

/**
 * Razorpay's publishable key id, when payments are on here and this buyer is
 * under the rate. Called after authorisation and before any Razorpay call, so
 * a refused attempt still counts; a missing key refuses rather than sharing
 * one counter between everybody.
 */
async function payable(rateKey: string): Promise<string> {
  if (!rateKey) throw new Refusal(PAYMENTS_OFF)
  let keys: ReturnType<typeof razorpayKeys> = null
  try {
    keys = razorpayKeys()
  } catch (err) {
    logger.error("Razorpay keys refused", { error: err instanceof Error ? err.message : String(err) })
  }
  if (!keys) throw new Refusal(PAYMENTS_OFF)
  const { count } = await hit(`billing:start:${rateKey}`, STARTS.windowMs)
  if (count > STARTS.max) throw new Refusal("Too many tries in a minute. Wait a moment and try again.")
  return keys.keyId
}

const NOT_YOUR_VENUE = "That venue isn't one of your organisation's."

/**
 * The caller may change this venue's plan: a venue owner who is an owner or
 * admin of the organisation that owns it (`mayManageVenueBilling`), with
 * payments on and under the rate. Anyone else's venue is "not yours", the
 * same answer as a venue that does not exist.
 */
async function requireVenueBuyer(venueId: string) {
  const user = await currentUser()
  if (!user) throw new Refusal("Unauthorized")
  const venue = await db.venues.findFirst({
    where: { id: venueId, deleted_at: null },
    select: { id: true, owner_org_id: true },
  })
  if (!venue?.owner_org_id) throw new Refusal(NOT_YOUR_VENUE)
  const member = await db.organisation_members.findFirst({
    where: { user_id: user.id, org_id: venue.owner_org_id, ...activeMembership },
    select: { role: true },
  })
  if (!member) throw new Refusal(NOT_YOUR_VENUE)
  if (!mayManageVenueBilling(user.role, member.role)) {
    throw new Refusal("Only an owner or admin of the venue's organisation can change its plan.")
  }
  return { user, orgId: venue.owner_org_id, keyId: await payable(`venue:${venue.id}`) }
}

/** The organisation's purchases, one at a time, until the transaction ends. */
async function lockOrg(tx: Prisma.TransactionClient, scope: string, orgId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${orgId}`}, 0))`
}

/**
 * A failure while starting: a Refusal stands; otherwise say whose it was. A
 * Razorpay failure means nothing was charged; a database failure after
 * Razorpay answered leaves an id at Razorpay with no row here, which is logged
 * so an operator can find it (and a subscription is cancelled, `dropOrphan`).
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

/**
 * A subscription Razorpay created whose row here was never written: nobody
 * was handed its id, so nobody can authorise it, and it is cancelled rather
 * than left to `expire_by`. A failed cancel is logged with the id; the
 * webhook refuses it either way (`unknown_ref`), so it can never grant.
 */
async function dropOrphan(subscriptionId: string | null): Promise<void> {
  if (!subscriptionId) return
  try {
    await cancelSubscription(subscriptionId, false)
  } catch (err) {
    logger.error("Cancelling an orphaned subscription at Razorpay failed; cancel it from the Razorpay dashboard", {
      orphanProviderRef: subscriptionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export interface SubscriptionCheckout {
  kind: "subscription"
  keyId: string
  subscriptionId: string
}

/**
 * What a subscription is for: an organisation's own plan (Analytics,
 * `venueId` null) or one venue's Venue Pro. Each has its own lock and its own
 * "one open subscription" index, so a venue owner may hold Pro on two venues
 * and never two mandates for one.
 */
interface SubscriptionScope {
  orgId: string
  venueId: string | null
  /** Said when one is already running, e.g. "Your organisation already has an Analytics subscription." */
  already: string
}

/** Start (or resume) a subscription for `scope`, on `plan`. The caller has authorised the buyer. */
async function startSubscription(
  scope: SubscriptionScope,
  plan: (typeof BILLING_PLANS)[BillingPlanKey],
  user: { id: string },
  keyId: string
): Promise<SubscriptionCheckout> {
  let orphan: string | null = null
  try {
    const subscriptionId = await db.$transaction(async (tx) => {
      if (scope.venueId) await lockOrg(tx, "billing-venue", scope.venueId)
      else await lockOrg(tx, "billing", scope.orgId)
      const now = new Date()
      const open = await tx.billing_checkouts.findMany({
        where: {
          ...(scope.venueId ? { venue_id: scope.venueId } : { org_id: scope.orgId, venue_id: null }),
          kind: "subscription",
          status: { in: [...OPEN_SUBSCRIPTION_STATUSES] },
        },
        orderBy: { created_at: "desc" },
        select: { id: true, provider_ref: true, plan_key: true, status: true, created_at: true },
      })
      if (open.some((s) => s.status !== "created")) throw new Refusal(scope.already)
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
      const sub = await createSubscription({
        planId,
        totalCount: plan.totalCount ?? 1,
        orgId: scope.orgId,
        venueId: scope.venueId,
        now,
      })
      orphan = sub.id
      await tx.billing_checkouts.create({
        data: {
          kind: "subscription",
          provider_ref: sub.id,
          provider_plan_id: planId,
          org_id: scope.orgId,
          venue_id: scope.venueId,
          plan_key: plan.key,
          amount_minor: chargeMinor(plan),
          status: sub.status || "created",
          created_by: user.id,
        },
      })
      await tx.audit_logs.create({
        data: {
          user_id: user.id,
          action: "billing.checkout.started",
          resource: scope.venueId ? "venue" : "organisation",
          resource_id: scope.venueId ?? scope.orgId,
          details: { plan: plan.key, providerRef: sub.id, orgId: scope.orgId },
        },
      })
      return sub.id
    }, TX)
    return { kind: "subscription", keyId, subscriptionId }
  } catch (err) {
    await dropOrphan(orphan)
    if (violatedConstraint(err, ONE_OPEN_PER_ORG) || violatedConstraint(err, ONE_OPEN_PER_VENUE)) {
      logger.warn("A second subscription start lost the race to the open one", { ...scope, orphanProviderRef: orphan })
      throw new Refusal(scope.already)
    }
    startFailure(err, "subscription", orphan)
  }
}

/** Start (or resume) an Analytics subscription for the caller's organisation. */
export async function startAnalyticsCheckout(period: "monthly" | "yearly"): Promise<SubscriptionCheckout> {
  const chosen = parse(periodSchema, period, "Choose monthly or yearly.")
  const { user, org, keyId } = await requireBuyer()
  const plan = BILLING_PLANS[chosen === "monthly" ? "analytics_monthly" : "analytics_yearly"]
  return startSubscription(
    { orgId: org.orgId, venueId: null, already: "Your organisation already has an Analytics subscription. Manage it below." },
    plan,
    user,
    keyId
  )
}

/**
 * Start (or resume) a Venue Pro subscription for one venue (plan v2 §9.1b).
 *
 * Refused until the venue has four weeks of venue-day data (the owner's
 * no-charge rule, `lib/venue-plan.ts`), and while Pro is already live on it —
 * a founding grant included: subscribe when it ends, never a charge on top of
 * a gift.
 */
export async function startVenueProCheckout(venueId: string, period: "monthly" | "yearly"): Promise<SubscriptionCheckout> {
  const id = parse(idSchema, venueId, NOT_YOUR_VENUE)
  const chosen = parse(periodSchema, period, "Choose monthly or yearly.")
  const { user, orgId, keyId } = await requireVenueBuyer(id)
  const ready = await venueReadiness(id)
  if (!ready.chargeable) {
    throw new Refusal(
      ready.chargeableFrom
        ? `Venue Pro can be bought from ${GRANT_DAY.format(ready.chargeableFrom)}: four weeks after people first went live here.`
        : "Venue Pro can be bought four weeks after people first go live at this venue."
    )
  }
  const live = await liveEntitlement({ kind: "venue", id }, "venue_pro")
  if (live) throw new Refusal(`This venue already has Venue Pro${live.expiresAt ? ` until ${GRANT_DAY.format(live.expiresAt)}` : ""}.`)
  const plan = BILLING_PLANS[chosen === "monthly" ? "venue_pro_monthly" : "venue_pro_yearly"]
  return startSubscription(
    { orgId, venueId: id, already: "This venue already has a Venue Pro subscription. Manage it below." },
    plan,
    user,
    keyId
  )
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
      // Nothing to sell while it is open anyway: the free window, or the first
      // event that cleared the floor (lib/analytics-access.ts).
      const access = await analyticsAccess(org.orgId)
      if (access.org) throw new Refusal("Every event's analytics are free for now, so there's nothing to buy yet.")
      if (mayOpenEvent(access, id)) throw new Refusal("That event's analytics are already open to you.")
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
      await tx.audit_logs.create({
        data: {
          user_id: user.id,
          action: "billing.checkout.started",
          resource: "organisation",
          resource_id: org.orgId,
          details: { plan: plan.key, providerRef: created.id, eventId: id },
        },
      })
      return { orderId: created.id, amountMinor: chargeMinor(plan) }
    }, TX)
    return { kind: "order", keyId, ...order }
  } catch (err) {
    // An order has no cancel at Razorpay: its id never left this server, so
    // nobody can pay it, and the webhook would refuse it (`unknown_ref`).
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
  await cancelOpen(user.id, { orgId: org.orgId, venueId: null })
}

/**
 * Stop the Venue Pro subscriptions on one venue that the caller's
 * organisation pays for (as `cancelAnalytics`).
 *
 * Authorised on who PAYS (`billing_checkouts.org_id`), not on who owns the
 * venue today (review M7): after the venue changes hands, the organisation
 * still paying can stop its own mandate, and the new owner can neither see
 * nor cancel it (`lib/subscription-cancel.ts` ends it on the transfer).
 */
export async function cancelVenuePro(venueId: string): Promise<void> {
  const id = parse(idSchema, venueId, NOT_YOUR_VENUE)
  const user = await currentUser()
  if (!user) throw new Refusal("Unauthorized")
  const payers = (
    await db.organisation_members.findMany({
      where: { user_id: user.id, ...activeMembership },
      select: { org_id: true, role: true },
    })
  )
    .filter((m) => mayManageVenueBilling(user.role, m.role))
    .map((m) => m.org_id)
  if (payers.length === 0) throw new Refusal("Only an owner or admin of the organisation that pays can cancel Venue Pro.")
  await payable(`venue:${id}`)
  await cancelOpen(user.id, { orgId: payers[0], venueId: id, payerOrgIds: payers })
}

async function cancelOpen(
  userId: string,
  scope: { orgId: string; venueId: string | null; payerOrgIds?: string[] }
): Promise<void> {
  const open = await db.billing_checkouts.findMany({
    where: {
      ...(scope.venueId
        ? { venue_id: scope.venueId, org_id: { in: scope.payerOrgIds ?? [scope.orgId] } }
        : { org_id: scope.orgId, venue_id: null }),
      kind: "subscription",
      status: { in: [...OPEN_SUBSCRIPTION_STATUSES] },
      cancel_at_cycle_end: false,
    },
    select: { id: true, provider_ref: true, status: true, org_id: true },
  })
  if (open.length === 0) throw new Refusal("There's no subscription to cancel, or it's already set to end.")
  for (const sub of open) {
    const outcome = await cancelThenRecord(sub, {
      userId,
      resource: scope.venueId ? "venue" : "organisation",
      resourceId: scope.venueId ?? scope.orgId,
    })
    if (outcome === "razorpay_refused") throw new Refusal("Razorpay didn't accept that just now. Nothing was cancelled; try again in a minute.")
    if (outcome === "not_recorded") {
      throw new Refusal("Razorpay has stopped it, but saving that here failed. This page catches up when Razorpay confirms.")
    }
  }
  revalidatePath("/dashboard/plan")
}

/* -------------------------------------------------------------------------- */
/* Platform admin: founding grants and revocations                             */
/* -------------------------------------------------------------------------- */

/** An admin's money actions: grants, ends and revokes, per admin. */
const ADMIN_ACTIONS = { max: 30, windowMs: 60_000 }

/** `requireAdmin`, then the admin's own limit on money changes. */
async function requireAdminWithinLimit() {
  const user = await requireAdmin()
  // Counted before the action runs, refusals included: a script holding an
  // admin session cannot loop grants.
  const { count } = await hit(`billing:admin:${user.id}`, ADMIN_ACTIONS.windowMs)
  if (count > ADMIN_ACTIONS.max) throw new Refusal("Too many changes in a minute. Wait a moment and try again.")
  return user
}

const RESOURCE = { org: "organisation", venue: "venue" } as const

/** End the subject's live grants and audit it, in one transaction: neither happens alone. */
async function endGrantAudited(
  adminId: string,
  subject: { kind: "org" | "venue"; id: string },
  product: "analytics" | "venue_pro",
  reason: string
): Promise<void> {
  await db.$transaction(async (tx) => {
    const ended = await endGrants(subject, product, new Date(), tx)
    if (ended === 0) throw new Refusal("That grant has already ended.")
    await tx.audit_logs.create({
      data: {
        user_id: adminId,
        action: "entitlement.grant_ended",
        resource: RESOURCE[subject.kind],
        resource_id: subject.id,
        details: { product: product, ended: ended, reason: reason },
      },
    })
  })
}

/** Revoke one live paid entitlement and audit it, in one transaction. Nothing is cancelled at Razorpay. */
async function revokePaidAudited(
  adminId: string,
  subject: { kind: "org" | "venue"; id: string },
  entitlementId: string,
  reason: string
): Promise<void> {
  await db.$transaction(async (tx) => {
    const revoked = await revokePaid(subject, entitlementId, new Date(), tx)
    if (!revoked) throw new Refusal("That entitlement isn't live, or isn't a paid one.")
    await tx.audit_logs.create({
      data: {
        user_id: adminId,
        action: "entitlement.revoked",
        resource: RESOURCE[subject.kind],
        resource_id: subject.id,
        details: { product: revoked.product, externalRef: revoked.externalRef, entitlementId: revoked.id, reason: reason },
      },
    })
  })
}

/** The founding grant is six months (plan v2 §9.1b); an admin may choose 1–24. */
export async function grantAnalytics(orgId: string, months: number, reason: string): Promise<{ expiresAt: string }> {
  const admin = await requireAdminWithinLimit()
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
  const admin = await requireAdminWithinLimit()
  const id = parse(idSchema, orgId, "Organisation not found")
  const why = parse(reasonSchema, reason, "Give a reason for ending this grant (10 to 500 characters).")
  await endGrantAudited(admin.id, { kind: "org", id }, "analytics", why)
  revalidatePath("/dashboard/organisations")
}

/**
 * End a live PAID entitlement now: a refund made outside Razorpay's webhook,
 * or a mistake. Does not cancel anything at Razorpay; the admin does that in
 * Razorpay's dashboard, and the reason says so.
 */
export async function revokePaidEntitlement(orgId: string, entitlementId: string, reason: string): Promise<void> {
  const admin = await requireAdminWithinLimit()
  const id = parse(idSchema, orgId, "Organisation not found")
  const ent = parse(idSchema, entitlementId, "That entitlement isn't live.")
  const why = parse(reasonSchema, reason, "Give a reason for revoking it (10 to 500 characters).")
  await revokePaidAudited(admin.id, { kind: "org", id }, ent, why)
  revalidatePath("/dashboard/organisations")
}

/* -------------------------------------------------------------------------- */
/* Platform admin: a venue's Venue Pro                                          */
/* -------------------------------------------------------------------------- */

/**
 * Venue Pro at no charge: the founding grant is three months per claimed
 * Bengaluru venue (plan v2 §9.1b); an admin may choose 1–24. Only a claimed
 * venue: Pro is for the owner, and an unclaimed venue has none.
 */
export async function grantVenuePro(venueId: string, months: number, reason: string): Promise<{ expiresAt: string }> {
  const admin = await requireAdminWithinLimit()
  const id = parse(idSchema, venueId, "Venue not found")
  const length = parse(monthsSchema, months, "A grant runs between 1 and 24 months.")
  const why = parse(reasonSchema, reason, "Record why this venue is being given Venue Pro (10 to 500 characters).")

  const venue = await db.venues.findUnique({ where: { id }, select: { id: true, name: true, owner_org_id: true, deleted_at: true } })
  if (!venue || venue.deleted_at) throw new Refusal("Venue not found")
  if (!venue.owner_org_id) throw new Refusal("Venue Pro is for a venue's owner. This one is unclaimed.")

  const grant = await db.$transaction(async (tx) => {
    // One live grant per venue: the check and the insert are one decision.
    await lockOrg(tx, "grant-venue", id)
    if (await liveGrant({ kind: "venue", id }, "venue_pro", new Date(), tx)) {
      throw new Refusal("This venue already has a grant. End it before giving a new one.")
    }
    const made = await grantEntitlement(tx, { subject: { kind: "venue", id }, product: "venue_pro", months: length })
    await tx.audit_logs.create({
      data: {
        user_id: admin.id,
        action: "entitlement.granted",
        resource: "venue",
        resource_id: id,
        details: {
          product: "venue_pro",
          months: length,
          expiresAt: made.expiresAt.toISOString(),
          reason: why,
          venueName: venue.name,
          orgId: venue.owner_org_id,
        },
      },
    })
    return made
  })
  revalidatePath(`/dashboard/venues/${id}`)
  return { expiresAt: grant.expiresAt.toISOString() }
}

/** End every live Venue Pro grant on the venue, now. */
export async function endVenueProGrant(venueId: string, reason: string): Promise<void> {
  const admin = await requireAdminWithinLimit()
  const id = parse(idSchema, venueId, "Venue not found")
  const why = parse(reasonSchema, reason, "Give a reason for ending this grant (10 to 500 characters).")
  await endGrantAudited(admin.id, { kind: "venue", id }, "venue_pro", why)
  revalidatePath(`/dashboard/venues/${id}`)
}

/** End a venue's live PAID Venue Pro now (as `revokePaidEntitlement`). Nothing is cancelled at Razorpay. */
export async function revokeVenueProPaid(venueId: string, entitlementId: string, reason: string): Promise<void> {
  const admin = await requireAdminWithinLimit()
  const id = parse(idSchema, venueId, "Venue not found")
  const ent = parse(idSchema, entitlementId, "That entitlement isn't live.")
  const why = parse(reasonSchema, reason, "Give a reason for revoking it (10 to 500 characters).")
  await revokePaidAudited(admin.id, { kind: "venue", id }, ent, why)
  revalidatePath(`/dashboard/venues/${id}`)
}
