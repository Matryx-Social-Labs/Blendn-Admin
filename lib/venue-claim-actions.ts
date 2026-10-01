"use server"

import { Refusal } from "./refusal"
import { z } from "zod"

import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
import { validateGstin, gstinMessage } from "@/lib/gstin"
import { venueTypeLabel } from "@/lib/venue-types"
import { reviewableUrl } from "@/lib/tigris"
import { claimants, notifyClaimant } from "@/lib/claim-decision-notify"
import { appUrl } from "@/lib/email"
import { homeOrgIdFor } from "@/lib/event-ownership"
import { isUuid } from "@/lib/api-input"
import { overClaimLimit } from "@/lib/claim-limit"
import { claimVenueWhere } from "@/lib/curation"
import { violatedConstraint } from "@/lib/prisma-errors"
import { logger } from "@/lib/logger"

/**
 * Claiming a venue.
 *
 * A claim is an **access request**, not data entry. Owning a venue record means
 * operational control over other people's events held there — an organiser
 * picking a claimed venue auto-links immediately, and the owner then gets the
 * chatroom, moderation and the attendee list for an event that is not theirs.
 *
 * Nothing in the evidence can be verified automatically. GSTIN is checksum-only
 * — `lib/gstin.ts` says so in the message it returns — and a trade licence is a
 * PDF. So a person decides, in the same queue shape as organiser onboarding.
 *
 * A claim against a venue that already has an owner is a **dispute**: the
 * incumbent is on record, and an admin weighs both sides rather than the newer
 * claim silently winning.
 *
 * The reason this does not have to be bulletproof: **auto-link is reversible.**
 * An organiser can unlink any event from a venue, with a reason, audited. A
 * wrong approval is recoverable, so the queue can be careful without being
 * paranoid.
 *
 * That sentence was false for as long as it has been written. `unlinkEventVenue`
 * existed, was tested and audited, and had **no caller** — so the recovery this
 * review bar was relaxed on the strength of could not be performed by anybody.
 * The control is on the event detail page now, gated on `canEdit`, and
 * `server-actions-reachable.test.ts` is what will notice if it goes away again.
 */

export interface ClaimEvidence {
  /** The one required document — it names the address. */
  tradeLicence?: string
  fssai?: string
  liquor?: string
  photo?: string
}

async function requireHost() {
  const session = await getAuth()
  if (!session?.user) throw new Refusal("Unauthorized")
  return session.user
}

export interface FileClaimInput {
  venueId: string
  gstin?: string
  evidence: ClaimEvidence
}

/**
 * `ClaimEvidence` is a TypeScript interface and is erased at runtime, so these
 * URLs arrived unchecked from a `"use server"` argument and were rendered into
 * an `<a href>` for the reviewing admin. React 19 blocks `javascript:` hrefs,
 * so it was not exploitable -- it was one React downgrade from being stored
 * XSS aimed squarely at an administrator. A type is not a validator.
 */
const evidenceSchema = z
  .object({
    tradeLicence: z.string().url().max(2048).optional(),
    fssai: z.string().url().max(2048).optional(),
    liquor: z.string().url().max(2048).optional(),
    photo: z.string().url().max(2048).optional(),
  })
  .strict()
  .refine(
    (e) =>
      Object.values(e).every(
        (u) => u === undefined || u.startsWith("https://") || u.startsWith("http://")
      ),
    { message: "Evidence links must be http(s) URLs" }
  )

export async function fileVenueClaim(
  input: FileClaimInput
): Promise<{ id: string; isDispute: boolean }> {
  const user = await requireHost()

  if (user.role !== "venue_owner" && user.role !== "app_admin") {
    // An organiser has no claim to operational control over other people's
    // events, which is what owning a venue grants.
    throw new Refusal("Only a venue owner can claim a venue.")
  }

  // The trade licence is the one document that names the address, so it is the
  // one that cannot be skipped. The rest vary by venue type — a park has no
  // FSSAI licence and a gallery has no liquor licence.
  if (!input.evidence.tradeLicence) {
    throw new Refusal("Attach a trade licence or Shops & Establishments registration.")
  }

  // After the role and required-document checks: someone who may not file at
  // all should be told that, not handed a critique of their input.
  const evidence = evidenceSchema.safeParse(input.evidence)
  if (!evidence.success) throw new Refusal("Evidence links must be http(s) URLs")

  if (input.gstin) {
    const result = validateGstin(input.gstin)
    if (!result.valid) throw new Refusal(gstinMessage(result))
  }

  // The same "my org" as everywhere else (SCRUM-148).
  const orgId = await homeOrgIdFor(user)
  if (!orgId) throw new Refusal("Your account is not attached to an organisation yet.")
  const membership = { org_id: orgId }

  const venue = await db.venues.findUnique({
    where: { id: input.venueId, deleted_at: null },
    select: { id: true, name: true, owner_org_id: true },
  })
  if (!venue) throw new Refusal("Venue not found")

  if (venue.owner_org_id === membership.org_id) {
    throw new Refusal("Your organisation already owns this venue.")
  }

  const isDispute = venue.owner_org_id !== null

  // Re-filing after a decline updates the row rather than stacking duplicates
  // for a reviewer to wade through.
  const claim = await db.venue_claims.upsert({
    where: { venue_id_org_id: { venue_id: venue.id, org_id: membership.org_id } },
    update: {
      status: "pending",
      is_dispute: isDispute,
      gstin: input.gstin?.trim().toUpperCase() || null,
      evidence: evidence.data as object,
      filed_by: user.id,
      reviewed_by: null,
      reviewed_at: null,
      decision_note: null,
    },
    create: {
      venue_id: venue.id,
      org_id: membership.org_id,
      filed_by: user.id,
      is_dispute: isDispute,
      gstin: input.gstin?.trim().toUpperCase() || null,
      evidence: evidence.data as object,
    },
    select: { id: true },
  })

  auditLog({
    userId: user.id,
    action: isDispute ? "venue.claim.disputed" : "venue.claim.filed",
    resource: "venue",
    resourceId: venue.id,
    details: { claimId: claim.id, orgId: membership.org_id, venue: venue.name },
  })

  revalidatePath("/dashboard/venues")
  return { id: claim.id, isDispute }
}

export interface FilePublicVenueClaimInput {
  venueId: string
  contactEmail: string
  /** The venue-owner application the form just filed. It must be this address's. */
  onboardingId: string
  gstin?: string
  note?: string
}

/**
 * "This place is mine" — from somebody with no account (`/claim/venue/[venueId]`).
 *
 * Every venue is live from day one and the founders seeded most of them, so the
 * person who runs a place usually meets its listing before they have a host
 * account. They apply as a venue owner through `/api/onboarding/apply` (the
 * only writer of applications) and this files the claim against that
 * application, the way `fileEventClaim` does for a curated event.
 *
 * Unauthenticated on purpose, and safe for the same reason: filing grants
 * nothing. A person reads it, and approving still needs the application
 * approved first, because that is what creates the organisation the venue is
 * handed to. The session is never read here: an account holder files from the
 * dashboard, with documents.
 */
export async function filePublicVenueClaim(
  input: FilePublicVenueClaimInput
): Promise<{ ok: true; claimId: string } | { ok: false; error: string }> {
  // venues.id is a UUID column; a malformed id is a missing venue, not a throw.
  if (!isUuid(input.venueId)) return { ok: false, error: "Venue not found" }

  const email = input.contactEmail.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Give an email address we can reply to" }
  }

  /*
   * The application has to be this address's own, and a venue owner's.
   *
   * Approval resolves the organisation from it, so a uuid that names somebody
   * else's application would hand the venue to them. And an organiser cannot
   * claim a venue from the dashboard (`fileVenueClaim`), so an organiser's
   * application cannot do it from here either.
   */
  const request = isUuid(input.onboardingId)
    ? await db.organiser_onboarding_requests.findUnique({
        where: { id: input.onboardingId },
        select: { contact_email: true, requested_role: true },
      })
    : null
  if (!request || request.contact_email.toLowerCase() !== email) {
    return { ok: false, error: "That application does not match this email address" }
  }
  if (request.requested_role !== "venue_owner") {
    return { ok: false, error: "That application is not for a venue" }
  }

  const givenGstin = input.gstin?.trim().toUpperCase() || null
  if (givenGstin) {
    const result = validateGstin(givenGstin)
    if (!result.valid) return { ok: false, error: gstinMessage(result) }
  }

  const limited = await overClaimLimit(email, { kind: "venue", id: input.venueId })
  if (limited) return { ok: false, error: limited }

  const venue = await db.venues.findUnique({
    where: claimVenueWhere(input.venueId),
    select: { id: true, name: true, owner_org_id: true },
  })
  if (!venue) return { ok: false, error: "Venue not found" }
  /*
   * A dispute needs an account. The dashboard path files one with documents
   * and an incumbent on record; a stranger's form against an owned venue is
   * not a claim a reviewer can weigh.
   */
  if (venue.owner_org_id) return { ok: false, error: "This place already has an owner on Blend'n" }

  try {
    const claim = await db.venue_claims.create({
      data: {
        venue_id: venue.id,
        onboarding_id: input.onboardingId,
        contact_email: email,
        gstin: givenGstin,
        note: input.note?.trim() || null,
      },
      select: { id: true },
    })
    auditLog({
      action: "venue.claim.filed",
      resource: "venue",
      resourceId: venue.id,
      details: { claimId: claim.id, onboardingId: input.onboardingId, withoutAccount: true },
    })
    return { ok: true, claimId: claim.id }
  } catch (error) {
    if (violatedConstraint(error, "venue_claims_one_pending_per_email")) {
      return { ok: false, error: "You already have a claim on this place waiting for review" }
    }
    logger.error("File public venue claim failed", {
      venueId: venue.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, error: "Could not file the claim" }
  }
}

export interface ClaimQueueRow {
  id: string
  venueId: string
  venueName: string
  venueAddress: string | null
  venueType: string
  /**
   * The organisation that would own it. For a no-account claim, the one its
   * application created once approved, and until then the name the applicant
   * gave, with `awaitingApplication` set.
   */
  orgName: string
  filedByName: string | null
  /** Who to write back to, for a claim filed with no account. */
  contactEmail: string | null
  note: string | null
  /**
   * Filed with no account, and its application is not approved yet: there is
   * no organisation to hand the venue to, so approving is refused. Shown before
   * the buttons rather than learned from a failed submit.
   */
  awaitingApplication: boolean
  isDispute: boolean
  gstin: string | null
  gstinCheck: string | null
  evidence: ClaimEvidence
  currentOwnerName: string | null
  /** Hosting history is evidence too — six events at a venue is a strong signal. */
  currentOwnerEventCount: number
  createdAt: Date
  /** Derived, never stored: what looks off, for the reviewer to weigh. */
  flags: string[]
}

export async function getVenueClaimQueue(): Promise<ClaimQueueRow[]> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Refusal("Forbidden")

  const claims = await db.venue_claims.findMany({
    where: { status: "pending" },
    // Oldest first: age is the SLA here as it is in moderation.
    orderBy: { created_at: "asc" },
    include: {
      org: { select: { display_name: true } },
      venue: {
        select: {
          id: true,
          name: true,
          address: true,
          city: true,
          venue_type: true,
          owner_org_id: true,
          owner_org: { select: { display_name: true } },
          // Live events only, as on the claim form (SCRUM-312).
          _count: { select: { events: { where: { deleted_at: null } } } },
        },
      },
    },
  })

  const filerIds = [...new Set(claims.flatMap((c) => (c.filed_by ? [c.filed_by] : [])))]
  const filers = filerIds.length
    ? await db.user.findMany({ where: { id: { in: filerIds } }, select: { id: true, name: true } })
    : []
  const filerName = new Map(filers.map((f) => [f.id, f.name]))

  // A no-account claim's organisation lives on its application once that is
  // approved -- where the hand-over looks too (SCRUM-454, the event queue). One
  // query for the page.
  const requestIds = claims.flatMap((c) => (c.onboarding_id ? [c.onboarding_id] : []))
  const requests = requestIds.length
    ? await db.organiser_onboarding_requests.findMany({
        where: { id: { in: requestIds } },
        select: { id: true, display_name: true, org: { select: { display_name: true } } },
      })
    : []
  const requestById = new Map(requests.map((r) => [r.id, r]))

  return Promise.all(claims.map(async (c) => {
    const stored = (c.evidence ?? {}) as ClaimEvidence
    // The stored reference is a private key for anything filed since
    // `claims/` existed; the reviewer gets a signed URL good for the sitting.
    const evidence = Object.fromEntries(
      await Promise.all(
        Object.entries(stored).map(async ([k, url]) => [k, url ? await reviewableUrl(url) : url])
      )
    ) as ClaimEvidence
    const flags: string[] = []

    const request = c.onboarding_id ? requestById.get(c.onboarding_id) : undefined
    const approvedOrg = c.org?.display_name ?? request?.org?.display_name ?? null
    const awaitingApplication = approvedOrg === null

    if (!evidence.tradeLicence) flags.push("No trade licence attached")
    if (!c.gstin) flags.push("No GSTIN given")
    if (c.is_dispute && c.venue.owner_org) {
      flags.push(
        `Already owned by ${c.venue.owner_org.display_name} (${c.venue._count.events} hosted event${c.venue._count.events === 1 ? "" : "s"})`
      )
    }

    return {
      id: c.id,
      venueId: c.venue.id,
      venueName: c.venue.name,
      venueAddress: [c.venue.address, c.venue.city].filter(Boolean).join(", ") || null,
      venueType: venueTypeLabel(c.venue.venue_type),
      orgName: approvedOrg ?? request?.display_name ?? "Unknown applicant",
      filedByName: c.filed_by ? (filerName.get(c.filed_by) ?? null) : null,
      contactEmail: c.contact_email,
      note: c.note,
      awaitingApplication,
      isDispute: c.is_dispute,
      gstin: c.gstin,
      // Recomputed rather than stored, so it cannot go stale against the
      // checksum implementation.
      gstinCheck: c.gstin ? gstinMessage(validateGstin(c.gstin)) : null,
      evidence,
      currentOwnerName: c.venue.owner_org?.display_name ?? null,
      currentOwnerEventCount: c.venue._count.events,
      createdAt: c.created_at,
      flags,
    }
  }))
}

/**
 * Approve a claim — the moment operational control transfers.
 *
 * Sets `owner_org_id` and `claimed_at` on the venue in the same transaction
 * that marks the claim approved, so the two cannot disagree. Any *other*
 * pending claim on that venue is declined at the same time: leaving them
 * pending would show a reviewer a queue of requests for a venue that now has an
 * owner.
 */
export async function decideVenueClaim(
  claimId: string,
  decision: "approve" | "decline",
  note?: string
): Promise<{ notified: boolean }> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Refusal("Forbidden")
  const admin = session.user

  const claim = await db.venue_claims.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      status: true,
      org_id: true,
      onboarding_id: true,
      contact_email: true,
      is_dispute: true,
      filed_by: true,
      venue: { select: { id: true, name: true, owner_org_id: true } },
    },
  })
  if (!claim) throw new Refusal("Claim not found")
  if (claim.status !== "pending") throw new Refusal("This claim has already been decided.")

  // A decline that reaches the claimant with no reason produces an identical
  // re-file, and the queue gets the same row again.
  const trimmed = note?.trim() ?? ""
  if (decision === "decline" && trimmed.length < 10) {
    throw new Refusal("Give a reason — it is sent to the claimant.")
  }

  /*
   * A claim filed with no account carries its application, not an
   * organisation. Approving the application creates the organisation and
   * records it on the request, so it is resolved from there at decision time,
   * as `decideEventClaim` does. Filing refused an application that was not the
   * claimant's own; checked again here, because this is the write that hands
   * the venue over.
   */
  const request = claim.onboarding_id
    ? await db.organiser_onboarding_requests.findUnique({
        where: { id: claim.onboarding_id },
        select: { org_id: true, contact_email: true },
      })
    : null
  if (request && request.contact_email.toLowerCase() !== (claim.contact_email ?? "").toLowerCase()) {
    throw new Refusal("The application on this claim belongs to a different email address.")
  }
  const orgId = claim.org_id ?? request?.org_id ?? null
  if (decision === "approve" && !orgId) {
    throw new Refusal("Approve their application first — there is no organisation to hand this venue to yet.")
  }

  // Read before the write: after it, nobody is pending any more.
  const losers =
    decision === "approve"
      ? await db.venue_claims.findMany({
          where: { venue_id: claim.venue.id, status: "pending", id: { not: claimId } },
          select: { filed_by: true, contact_email: true },
        })
      : []

  await db.$transaction(async (tx) => {
    await tx.venue_claims.update({
      where: { id: claimId },
      data: {
        status: decision === "approve" ? "approved" : "declined",
        reviewed_by: admin.id,
        reviewed_at: new Date(),
        decision_note: trimmed || null,
        // The row says who got the venue. `venue_claims_one_claimant` wants
        // exactly one of the pair, so the application goes as the organisation
        // arrives.
        ...(decision === "approve" && !claim.org_id ? { org_id: orgId, onboarding_id: null } : {}),
      },
    })

    if (decision !== "approve") return

    await tx.venues.update({
      where: { id: claim.venue.id },
      data: { owner_org_id: orgId, claimed_at: new Date() },
    })

    // One owner per venue, so every other request for it is now moot.
    await tx.venue_claims.updateMany({
      where: { venue_id: claim.venue.id, status: "pending", id: { not: claimId } },
      data: {
        status: "declined",
        reviewed_by: admin.id,
        reviewed_at: new Date(),
        decision_note: "Another claim on this venue was approved.",
      },
    })
  })

  const notified = await tellVenueClaimants(claim, decision, trimmed || null, losers)

  auditLog({
    userId: admin.id,
    action: decision === "approve" ? "venue.claim.approved" : "venue.claim.declined",
    resource: "venue",
    resourceId: claim.venue.id,
    details: {
      claimId,
      orgId,
      wasDispute: claim.is_dispute,
      previousOwnerOrgId: claim.venue.owner_org_id,
      note: trimmed || null,
      emailSent: notified,
    },
  })

  revalidatePath("/dashboard/venue-owners")
  revalidatePath(`/dashboard/venues/${claim.venue.id}`)
  return { notified }
}

interface Claimant {
  filed_by: string | null
  contact_email: string | null
}

/** The decided claimant hears the reason; on an approval so do the ones it displaced. */
async function tellVenueClaimants(
  claim: Claimant & { venue: { name: string } },
  decision: "approve" | "decline",
  reason: string | null,
  losers: Claimant[]
): Promise<boolean> {
  const who = await claimants([claim, ...losers].flatMap((c) => (c.filed_by ? [c.filed_by] : [])))
  // An account holder is reached through their user; somebody with no account
  // through the address they filed with -- there is nobody else to ask.
  const addressOf = (c: Claimant) =>
    (c.filed_by ? who.get(c.filed_by) : undefined) ??
    (c.contact_email ? { email: c.contact_email, name: null } : undefined)
  const what = `the venue ${claim.venue.name}`
  const filer = addressOf(claim)
  const notified = filer
    ? await notifyClaimant({
        to: filer.email,
        name: filer.name,
        what,
        outcome: decision === "approve" ? "approved" : "declined",
        reason,
        link: decision === "approve" ? `${appUrl()}/dashboard/venues` : null,
      })
    : false
  for (const l of losers) {
    const u = addressOf(l)
    if (u && u.email !== filer?.email)
      await notifyClaimant({ to: u.email, name: u.name, what, outcome: "declined", reason: "Another claim on this venue was approved.", link: null })
  }
  return notified
}
