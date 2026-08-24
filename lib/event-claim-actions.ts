"use server"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { claimFlags, type ClaimFlag } from "@/lib/claim-flags"
import { claimRefusal, curationSelect } from "@/lib/curation"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"

/**
 * "This event is mine."
 *
 * The acquisition. A curated event sits in a city doing its job; the real
 * organiser finds it, proves it, and takes it over — at which point they are on
 * the platform, with an event that already has attendees.
 *
 * The third instance of the venue-claim pattern. What differs is documented on
 * `event_claims` in the schema; what is the same is the important part —
 * **nothing auto-approves**, a human reads flags, and approval is a single
 * column write because `eventPermissions` already reads `organizer_org_id`.
 */

export interface FileClaimInput {
  eventId: string
  contactEmail: string
  note?: string
  /** The claimant's organisation, when they have one. */
  orgId?: string
  /** The onboarding request that will create one, when they do not. */
  onboardingId?: string
}

export async function fileEventClaim(
  input: FileClaimInput
): Promise<{ ok: true; claimId: string; flags: ClaimFlag[] } | { ok: false; error: string }> {
  /*
   * Deliberately not authenticated.
   *
   * Most claims arrive from somebody with no account — that is why the event
   * was curated in the first place. Requiring a login here would turn the
   * acquisition funnel into a signup wall in front of the acquisition funnel.
   *
   * The claim proves nothing by existing; a human reads it. What protects this
   * is that filing costs nothing and grants nothing.
   */
  if (Boolean(input.orgId) === Boolean(input.onboardingId)) {
    return { ok: false, error: "A claim needs exactly one of an organisation or an onboarding request" }
  }

  const email = input.contactEmail.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Give an email address we can reply to" }
  }

  const event = await db.events.findUnique({
    where: { id: input.eventId, deleted_at: null },
    select: { id: true, title: true, source_url: true, ...curationSelect },
  })
  if (!event) return { ok: false, error: "Event not found" }

  /*
   * The same gate the read path uses, so the form and the submit cannot
   * disagree — which is the failure mode the chat write path spent a whole
   * workstream on.
   */
  const refusal = claimRefusal(event)
  if (refusal === "not_curated") return { ok: false, error: "This event already has an organiser" }
  if (refusal === "already_claimed") return { ok: false, error: "This event has already been claimed" }
  if (refusal === "room_open") {
    return {
      ok: false,
      error:
        "This event is running. Claims reopen once the room closes — we cannot hand over an attendee list mid-event.",
    }
  }

  const [priorClaims, verified] = await Promise.all([
    db.event_claims.count({ where: { event_id: event.id } }),
    input.orgId
      ? db.organisation_domains.findMany({
          where: { org_id: input.orgId, verified_at: { not: null } },
          select: { domain: true },
        })
      : Promise.resolve([]),
  ])

  const flags = claimFlags({
    contactEmail: email,
    sourceUrl: event.source_url,
    verifiedDomains: verified.map((d) => d.domain.toLowerCase()),
    priorClaims,
    withoutOrg: !input.orgId,
  })

  try {
    const claim = await db.event_claims.create({
      data: {
        event_id: event.id,
        org_id: input.orgId ?? null,
        onboarding_id: input.onboardingId ?? null,
        contact_email: email,
        note: input.note?.trim() || null,
        flags,
      },
      select: { id: true },
    })

    logger.info("Event claim filed", { eventId: event.id, claimId: claim.id, flags })
    return { ok: true, claimId: claim.id, flags }
  } catch (error) {
    /*
     * The partial unique indexes refuse a second PENDING claim from the same
     * claimant. Re-filing after a decision is allowed and creates a new row --
     * that is the count a reviewer needs -- so this is only ever "you already
     * asked and we have not answered yet".
     */
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("event_claims_one_pending")) {
      return { ok: false, error: "You already have a claim on this event waiting for review" }
    }
    logger.error("File event claim failed", { error: message })
    return { ok: false, error: "Could not file the claim" }
  }
}

/**
 * Decide one.
 *
 * Approval is `organizer_org_id` plus `claimed_at`, and nothing else. Every
 * screen unlocks from that one write because `eventPermissions` already reads
 * the column — which is the strongest argument for representing curation the
 * way this does.
 *
 * `organizer_id` is **not** rewritten. CLAUDE.md is explicit that it records who
 * created the row, and that stays true: the platform did. Who to *display* as
 * the host is a different question and belongs in the response layer.
 */
export async function decideEventClaim(
  claimId: string,
  decision: "approve" | "decline",
  note?: string
): Promise<void> {
  const session = await getAuth()
  if (session?.user?.role !== "app_admin") throw new Error("Forbidden")
  const admin = session.user

  const claim = await db.event_claims.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      status: true,
      org_id: true,
      event: { select: { id: true, title: true, ...curationSelect } },
    },
  })
  if (!claim) throw new Error("Claim not found")
  if (claim.status !== "pending") throw new Error("This claim has already been decided.")

  // A decline with no reason produces an identical re-file, and the queue gets
  // the same row again. Same rule as the venue queue.
  const trimmed = note?.trim() ?? ""
  if (decision === "decline" && trimmed.length < 10) {
    throw new Error("Give a reason — it is sent to the claimant.")
  }

  if (decision === "approve") {
    if (!claim.org_id) {
      throw new Error(
        "Approve the onboarding request first — there is no organisation to hand this to yet."
      )
    }
    /*
     * Re-checked at decision time, not only at filing.
     *
     * A claim can sit in the queue for days. In that time the event can start,
     * or somebody else's claim can be approved. Trusting the filing-time check
     * is how an approval lands in the middle of a live event.
     */
    const refusal = claimRefusal(claim.event)
    if (refusal) {
      throw new Error(
        refusal === "already_claimed"
          ? "Somebody else's claim was approved first."
          : "This event is running. Decide once the room has closed."
      )
    }
  }

  await db.$transaction(async (tx) => {
    await tx.event_claims.update({
      where: { id: claimId },
      data: {
        status: decision === "approve" ? "approved" : "declined",
        reviewed_by: admin.id,
        reviewed_at: new Date(),
        decision_note: trimmed || null,
      },
    })

    if (decision !== "approve") return

    // The one write that unlocks every screen.
    await tx.events.update({
      where: { id: claim.event.id },
      data: { organizer_org_id: claim.org_id, claimed_at: new Date() },
    })

    /*
     * Everyone else who asked is superseded, not declined.
     *
     * `declined` is a judgement about the claimant and reaches them as one. A
     * claim that lost a race deserves a different word, and a reviewer looking
     * at the queue later needs to be able to tell the two apart.
     */
    await tx.event_claims.updateMany({
      where: { event_id: claim.event.id, status: "pending", id: { not: claimId } },
      data: { status: "superseded", reviewed_at: new Date() },
    })
  })

  auditLog({
    userId: admin.id,
    action: decision === "approve" ? "event_claim.approved" : "event_claim.declined",
    resource: "event_claim",
    resourceId: claimId,
    details: { eventId: claim.event.id, title: claim.event.title, orgId: claim.org_id },
  })
}
