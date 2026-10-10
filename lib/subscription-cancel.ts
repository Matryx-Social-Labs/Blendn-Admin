import type { Prisma } from "@prisma/client"

import { auditInTx } from "./audit-log"
import { OPEN_SUBSCRIPTION_STATUSES } from "@/lib/billing"
import { db } from "@/lib/db"
import { revokePaidByRefs } from "@/lib/entitlements"
import { logger } from "@/lib/logger"
import { cancelSubscription, RazorpayError } from "@/lib/razorpay"

/**
 * Stopping a subscription, in the one order that cannot leave access open or
 * a charge unrecorded (plan v2 §9.2):
 *
 *   1. Razorpay first. A cancel Razorpay refused changes nothing here: the
 *      mandate may still charge, so this side must keep saying so.
 *   2. Only then our record, and its audit row, in one transaction: a cancel
 *      is never recorded without who did it, nor audited without happening.
 *
 * A crash between the two leaves Razorpay cancelled and this side open. That
 * is logged with the provider id, and repaired by Razorpay's own
 * `subscription.cancelled`, which the webhook applies (status, and access to
 * the end of what was paid). Nothing here grants; the entitlement only ever
 * moves in the webhook, or ends.
 *
 * Plain module, not "use server": these take ids the caller has authorised.
 */

export type CancelOutcome = "cancelled" | "razorpay_refused" | "not_recorded"

interface OpenSubscription {
  id: string
  provider_ref: string
  status: string
  org_id: string
}

export async function cancelThenRecord(
  sub: OpenSubscription,
  audit: { userId: string; resource: "organisation" | "venue"; resourceId: string; reason?: string }
): Promise<CancelOutcome> {
  // A running one stops renewing and keeps what was paid for; any other ends now.
  const atCycleEnd = sub.status === "active"
  try {
    await cancelSubscription(sub.provider_ref, atCycleEnd)
  } catch (err) {
    logger.error("Razorpay refused a subscription cancel; it is still open here", {
      providerRef: sub.provider_ref,
      status: err instanceof RazorpayError ? err.status : undefined,
      error: err instanceof Error ? err.message : String(err),
    })
    return "razorpay_refused"
  }
  try {
    await db.$transaction(async (tx) => {
      await tx.billing_checkouts.update({
        where: { id: sub.id },
        data: { cancel_at_cycle_end: true, ...(sub.status === "created" ? { status: "expired" } : {}) },
      })
      await auditInTx(tx, {
        userId: audit.userId,
        action: "billing.subscription.cancelled",
        resource: audit.resource,
        resourceId: audit.resourceId,
        details: { providerRef: sub.provider_ref, atCycleEnd, orgId: sub.org_id, ...(audit.reason ? { reason: audit.reason } : {}) },
        // The payer's, whatever the venue's owner is now (step 18, M3).
        orgId: sub.org_id,
      })
    })
  } catch (err) {
    logger.error("Razorpay cancelled a subscription but recording it here failed; its subscription.cancelled webhook settles it", {
      providerRef: sub.provider_ref,
      error: err instanceof Error ? err.message : String(err),
    })
    return "not_recorded"
  }
  return "cancelled"
}

/*
 * A venue changed hands (an approved dispute, `decideVenueClaim`): the
 * previous owner's Venue Pro does not come with it (review M7). Two halves.
 */

/**
 * Inside the transfer's own transaction: every live PAID Venue Pro another
 * organisation paid for ends now, audited on the venue. The transfer and the
 * end commit together or not at all, so the new owner never holds, even for a
 * moment, a Pro somebody else pays for. A grant stays: an admin gave it to
 * the venue and ends it there.
 */
export async function endPreviousOwnersPro(
  tx: Prisma.TransactionClient,
  venueId: string,
  newOwnerOrgId: string,
  adminId: string
): Promise<number> {
  const paidByOthers = await tx.billing_checkouts.findMany({
    where: { venue_id: venueId, kind: "subscription", org_id: { not: newOwnerOrgId } },
    select: { provider_ref: true, org_id: true },
  })
  /*
   * Audited to each payer, with its own entitlements, and to nobody else (step
   * 18, M3): what one organisation paid for is in its log, never the new
   * owner's. The new owner gets one row that says it happened, with nothing of
   * the previous payer's in it.
   */
  const byPayer = new Map<string, string[]>()
  for (const c of paidByOthers) byPayer.set(c.org_id, [...(byPayer.get(c.org_id) ?? []), c.provider_ref])
  let total = 0
  for (const [payer, refs] of byPayer) {
    const ended = await revokePaidByRefs({ kind: "venue", id: venueId }, "venue_pro", refs, new Date(), tx)
    if (ended.length === 0) continue
    total += ended.length
    await auditInTx(tx, {
      userId: adminId,
      action: "entitlement.ended_on_transfer",
      resource: "venue",
      resourceId: venueId,
      details: { ended: ended.length, entitlementIds: ended.map((e) => e.id) },
      orgId: payer,
    })
  }
  if (total > 0) {
    await auditInTx(tx, {
      userId: adminId,
      action: "entitlement.previous_owner_pro_ended",
      resource: "venue",
      resourceId: venueId,
      details: { note: "Venue Pro from the previous owner ended at transfer" },
      orgId: newOwnerOrgId,
    })
  }
  return total
}

/**
 * After the transfer commits: each mandate another organisation holds on the
 * venue is cancelled (`cancelThenRecord`). Never throws: the venue has
 * already moved. A cancel Razorpay refused is audited for an operator; a
 * mandate that still charges grants nothing to a venue its payer no longer
 * owns and is cancelled by the webhook (`billing.payer_not_owner`), and the
 * payer can stop it from its own Plan page (`cancelVenuePro`).
 */
export async function cancelPreviousOwnersMandates(
  venueId: string,
  newOwnerOrgId: string,
  adminId: string
): Promise<{ cancelled: string[]; failed: string[] }> {
  try {
    return await cancelEach(venueId, newOwnerOrgId, adminId)
  } catch (err) {
    // The venue has moved and its Pro has ended; only the mandates are left
    // open. Said here, never thrown into the approval that already committed.
    logger.error("Cancelling the previous owner's Venue Pro mandates failed; cancel them from the Razorpay dashboard", {
      venueId,
      newOwnerOrgId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { cancelled: [], failed: [] }
  }
}

async function cancelEach(venueId: string, newOwnerOrgId: string, adminId: string): Promise<{ cancelled: string[]; failed: string[] }> {
  const open = await db.billing_checkouts.findMany({
    where: {
      venue_id: venueId,
      kind: "subscription",
      status: { in: [...OPEN_SUBSCRIPTION_STATUSES] },
      cancel_at_cycle_end: false,
      org_id: { not: newOwnerOrgId },
    },
    select: { id: true, provider_ref: true, status: true, org_id: true },
  })
  const cancelled: string[] = []
  const failed: string[] = []
  for (const sub of open) {
    const outcome = await cancelThenRecord(sub, { userId: adminId, resource: "venue", resourceId: venueId, reason: "venue_changed_hands" })
    if (outcome === "cancelled") {
      cancelled.push(sub.provider_ref)
      continue
    }
    failed.push(sub.provider_ref)
    if (outcome === "razorpay_refused") {
      // Awaited and never thrown: a failed write of this row is logged, and the cancel loop carries on.
      await auditInTx(db, {
        userId: adminId,
        action: "billing.subscription.cancel_failed",
        resource: "venue",
        resourceId: venueId,
        details: { providerRef: sub.provider_ref, orgId: sub.org_id, newOwnerOrgId, todo: "cancel it from the Razorpay dashboard" },
        // The payer's; it names the new owner, which only the payer and the platform may read.
        orgId: sub.org_id,
      }).catch((err: unknown) =>
        logger.error("Auditing a refused Venue Pro cancel failed", {
          providerRef: sub.provider_ref,
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }
  }
  return { cancelled, failed }
}
