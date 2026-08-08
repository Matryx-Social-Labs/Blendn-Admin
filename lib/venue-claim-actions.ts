"use server"

import { z } from "zod"

import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
import { validateGstin, gstinMessage } from "@/lib/gstin"
import { venueTypeLabel } from "@/lib/venue-types"

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
  if (!session?.user) throw new Error("Unauthorized")
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
    throw new Error("Only a venue owner can claim a venue.")
  }

  // The trade licence is the one document that names the address, so it is the
  // one that cannot be skipped. The rest vary by venue type — a park has no
  // FSSAI licence and a gallery has no liquor licence.
  if (!input.evidence.tradeLicence) {
    throw new Error("Attach a trade licence or Shops & Establishments registration.")
  }

  // After the role and required-document checks: someone who may not file at
  // all should be told that, not handed a critique of their input.
  const evidence = evidenceSchema.safeParse(input.evidence)
  if (!evidence.success) throw new Error("Evidence links must be http(s) URLs")

  if (input.gstin) {
    const result = validateGstin(input.gstin)
    if (!result.valid) throw new Error(gstinMessage(result))
  }

  const membership = await db.organisation_members.findFirst({
    where: { user_id: user.id },
    select: { org_id: true },
  })
  if (!membership) throw new Error("Your account is not attached to an organisation yet.")

  const venue = await db.venues.findUnique({
    where: { id: input.venueId, deleted_at: null },
    select: { id: true, name: true, owner_org_id: true },
  })
  if (!venue) throw new Error("Venue not found")

  if (venue.owner_org_id === membership.org_id) {
    throw new Error("Your organisation already owns this venue.")
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

export interface ClaimQueueRow {
  id: string
  venueId: string
  venueName: string
  venueAddress: string | null
  venueType: string
  orgName: string
  filedByName: string | null
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
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")

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
          _count: { select: { events: true } },
        },
      },
    },
  })

  const filerIds = [...new Set(claims.map((c) => c.filed_by))]
  const filers = filerIds.length
    ? await db.user.findMany({ where: { id: { in: filerIds } }, select: { id: true, name: true } })
    : []
  const filerName = new Map(filers.map((f) => [f.id, f.name]))

  return claims.map((c) => {
    const evidence = (c.evidence ?? {}) as ClaimEvidence
    const flags: string[] = []

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
      orgName: c.org.display_name,
      filedByName: filerName.get(c.filed_by) ?? null,
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
  })
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
): Promise<void> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")
  const admin = session.user

  const claim = await db.venue_claims.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      status: true,
      org_id: true,
      is_dispute: true,
      venue: { select: { id: true, name: true, owner_org_id: true } },
    },
  })
  if (!claim) throw new Error("Claim not found")
  if (claim.status !== "pending") throw new Error("This claim has already been decided.")

  // A decline that reaches the claimant with no reason produces an identical
  // re-file, and the queue gets the same row again.
  const trimmed = note?.trim() ?? ""
  if (decision === "decline" && trimmed.length < 10) {
    throw new Error("Give a reason — it is sent to the claimant.")
  }

  await db.$transaction(async (tx) => {
    await tx.venue_claims.update({
      where: { id: claimId },
      data: {
        status: decision === "approve" ? "approved" : "declined",
        reviewed_by: admin.id,
        reviewed_at: new Date(),
        decision_note: trimmed || null,
      },
    })

    if (decision !== "approve") return

    await tx.venues.update({
      where: { id: claim.venue.id },
      data: { owner_org_id: claim.org_id, claimed_at: new Date() },
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

  auditLog({
    userId: admin.id,
    action: decision === "approve" ? "venue.claim.approved" : "venue.claim.declined",
    resource: "venue",
    resourceId: claim.venue.id,
    details: {
      claimId,
      orgId: claim.org_id,
      wasDispute: claim.is_dispute,
      previousOwnerOrgId: claim.venue.owner_org_id,
      note: trimmed || null,
    },
  })

  revalidatePath("/dashboard/venue-owners")
  revalidatePath(`/dashboard/venues/${claim.venue.id}`)
}
