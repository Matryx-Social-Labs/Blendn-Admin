"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { gstinMessage, validateGstin } from "@/lib/gstin"
import { actorFor } from "@/lib/org-membership"

/**
 * Claiming a brand.
 *
 * The same problem as `lib/venue-claim-actions.ts`, and deliberately the same
 * shape. An organiser adds "Red Bull" to their event from the messaging screen;
 * the real company turns up a month later and needs that row, with the
 * placements already attached to it, rather than a second one.
 *
 * ## What approving actually grants
 *
 * Ownership of the brand row: the name and logo shown beside a sponsored
 * message, and the reporting on every placement it has ever had.
 *
 * It does **not** grant the right to place a sponsored message. That is
 * `organisations.may_sponsor`, granted separately by an admin, and keeping the
 * two apart is the point — one says "this is your brand", the other says "you
 * have a commercial agreement". The queue shows whether the grant is present so
 * an admin can do both in one sitting, but approving a claim never sets it.
 *
 * ## Why one brand per organisation
 *
 * `getMyBrand` resolves an organisation's brand with `findFirst`. A second
 * approved brand under the same organisation would make `/dashboard/brand` show
 * an arbitrary one of the two, which is a silent wrong-brand bug rather than a
 * visible error. So this refuses, and points at the merge screen — which is the
 * correct tool for "these two rows are the same company".
 */

export interface SponsorClaimEvidence {
  /** The one required document: a letter on company letterhead, or a trademark certificate. */
  authorisation?: string
  incorporation?: string
  other?: string
}

const evidenceSchema = z
  .object({
    authorisation: z.string().url().max(2048).optional(),
    incorporation: z.string().url().max(2048).optional(),
    other: z.string().url().max(2048).optional(),
  })
  .strict()
  .refine(
    (e) =>
      Object.values(e).every(
        (u) => u === undefined || u.startsWith("https://") || u.startsWith("http://")
      ),
    { message: "Evidence links must be http(s) URLs" }
  )

export interface ClaimableBrand {
  id: string
  name: string
  website: string | null
  placements: number
  /** True when this organisation has already filed against it. */
  alreadyFiled: boolean
}

/**
 * Unclaimed brands matching a search, for a sponsor about to create a duplicate.
 *
 * Unclaimed only. A brand somebody else owns is a dispute, and a dispute is not
 * something to stumble into from a search box — it goes through an admin who can
 * see both sides.
 */
export async function findClaimableBrands(query: string): Promise<ClaimableBrand[]> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const q = query.trim()
  if (q.length < 2) return []

  const actor = await actorFor(session.user)

  const rows = await db.sponsors.findMany({
    where: {
      org_id: null,
      deleted_at: null,
      merged_into: null,
      name: { contains: q, mode: "insensitive" },
    },
    select: {
      id: true,
      name: true,
      website: true,
      _count: { select: { placements: true } },
      claims: {
        where: { org_id: { in: actor.orgIds }, status: "pending" },
        select: { id: true },
      },
    },
    take: 8,
    orderBy: { name: "asc" },
  })

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    website: r.website,
    placements: r._count.placements,
    alreadyFiled: r.claims.length > 0,
  }))
}

export interface FileSponsorClaimInput {
  sponsorId: string
  gstin?: string
  evidence: SponsorClaimEvidence
}

export async function fileSponsorClaim(
  input: FileSponsorClaimInput
): Promise<{ id: string; isDispute: boolean }> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")
  const user = session.user

  if (user.role !== "sponsor" && user.role !== "app_admin") {
    throw new Error("Only a sponsor account can claim a brand.")
  }

  // The document that names the company. The rest vary — a sole proprietor has
  // no certificate of incorporation.
  if (!input.evidence.authorisation) {
    throw new Error("Attach a letter on company letterhead or a trademark certificate.")
  }

  // Role and required-document checks first: someone who may not file at all
  // should be told that, not handed a critique of their links.
  const evidence = evidenceSchema.safeParse(input.evidence)
  if (!evidence.success) throw new Error("Evidence links must be http(s) URLs")

  if (input.gstin) {
    const result = validateGstin(input.gstin)
    if (!result.valid) throw new Error(gstinMessage(result))
  }

  const actor = await actorFor(user)
  const orgId = actor.orgIds[0]
  if (!orgId) throw new Error("Your account is not attached to an organisation yet.")

  const sponsor = await db.sponsors.findUnique({
    where: { id: input.sponsorId },
    select: { id: true, name: true, org_id: true, deleted_at: true, merged_into: true },
  })
  if (!sponsor || sponsor.deleted_at || sponsor.merged_into) throw new Error("Brand not found")

  if (sponsor.org_id === orgId) throw new Error("Your organisation already owns this brand.")

  const owned = await db.sponsors.findFirst({
    where: { org_id: orgId, deleted_at: null, merged_into: null },
    select: { name: true },
  })
  if (owned) {
    throw new Error(
      `Your organisation already has a brand (${owned.name}). Ask an admin to merge the two rather than claiming a second one.`
    )
  }

  const isDispute = sponsor.org_id !== null

  // Re-filing after a rejection updates the row rather than stacking duplicates
  // for a reviewer to wade through.
  const claim = await db.sponsor_claims.upsert({
    where: { sponsor_id_org_id: { sponsor_id: sponsor.id, org_id: orgId } },
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
      sponsor_id: sponsor.id,
      org_id: orgId,
      filed_by: user.id,
      is_dispute: isDispute,
      gstin: input.gstin?.trim().toUpperCase() || null,
      evidence: evidence.data as object,
    },
    select: { id: true },
  })

  auditLog({
    userId: user.id,
    action: isDispute ? "sponsor.claim.disputed" : "sponsor.claim.filed",
    resource: "sponsors",
    resourceId: sponsor.id,
    details: { claimId: claim.id, orgId, brand: sponsor.name },
  })

  revalidatePath("/dashboard/brand")
  return { id: claim.id, isDispute }
}

export interface SponsorClaimQueueRow {
  id: string
  sponsorId: string
  brandName: string
  brandWebsite: string | null
  orgName: string
  orgWebsite: string | null
  filedByName: string | null
  isDispute: boolean
  gstin: string | null
  gstinCheck: string | null
  evidence: SponsorClaimEvidence
  currentOwnerName: string | null
  /** Placements already attached — they transfer with the brand. */
  placements: number
  createdAt: Date
  /** Derived, never stored: what looks off, for the reviewer to weigh. */
  flags: string[]
}

export async function getSponsorClaimQueue(): Promise<SponsorClaimQueueRow[]> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")

  const claims = await db.sponsor_claims.findMany({
    where: { status: "pending" },
    // Oldest first: age is the SLA here as it is in moderation.
    orderBy: { created_at: "asc" },
    include: {
      org: {
        select: {
          display_name: true,
          website: true,
          may_sponsor: true,
          sponsors: {
            where: { deleted_at: null, merged_into: null },
            select: { name: true },
          },
        },
      },
      sponsor: {
        select: {
          id: true,
          name: true,
          website: true,
          org: { select: { display_name: true } },
          _count: { select: { placements: true } },
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
    const evidence = (c.evidence ?? {}) as SponsorClaimEvidence
    const flags: string[] = []

    if (!evidence.authorisation) flags.push("No authorisation document attached")
    if (!c.gstin) flags.push("No GSTIN given")
    if (c.is_dispute && c.sponsor.org) {
      flags.push(`Already owned by ${c.sponsor.org.display_name}`)
    }
    if (c.org.sponsors.length > 0) {
      // Blocks approval outright, so it belongs at the top of the reviewer's
      // attention rather than in the error toast after they click.
      flags.push(
        `This organisation already owns ${c.org.sponsors[0].name} — merge instead of approving`
      )
    }
    if (!c.org.may_sponsor) {
      flags.push("Organisation cannot place sponsored messages yet (may_sponsor is off)")
    }
    /*
     * A website that does not match is the cheapest real signal available. Not a
     * flag when either side is missing one — absence is not a mismatch.
     */
    const brandHost = hostOf(c.sponsor.website)
    const orgHost = hostOf(c.org.website)
    if (brandHost && orgHost && brandHost !== orgHost) {
      flags.push(`Websites differ: brand is ${brandHost}, organisation is ${orgHost}`)
    }

    return {
      id: c.id,
      sponsorId: c.sponsor.id,
      brandName: c.sponsor.name,
      brandWebsite: c.sponsor.website,
      orgName: c.org.display_name,
      orgWebsite: c.org.website,
      filedByName: filerName.get(c.filed_by) ?? null,
      isDispute: c.is_dispute,
      gstin: c.gstin,
      // Recomputed rather than stored, so it cannot go stale against the
      // checksum implementation.
      gstinCheck: c.gstin ? gstinMessage(validateGstin(c.gstin)) : null,
      evidence,
      currentOwnerName: c.sponsor.org?.display_name ?? null,
      placements: c.sponsor._count.placements,
      createdAt: c.created_at,
      flags,
    }
  })
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase()
  } catch {
    return null
  }
}

/**
 * Approve or reject a claim.
 *
 * Approving sets `org_id` and `claimed_at` on the brand in the same transaction
 * that marks the claim approved, so the two cannot disagree. Every other pending
 * claim on that brand is rejected at the same time — the migration carries a
 * partial unique index allowing one approved claim per brand, so leaving others
 * pending would queue up rows that can never be approved.
 */
export async function decideSponsorClaim(
  claimId: string,
  decision: "approve" | "reject",
  note?: string
): Promise<void> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")
  const admin = session.user

  const claim = await db.sponsor_claims.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      status: true,
      org_id: true,
      is_dispute: true,
      sponsor: { select: { id: true, name: true, name_key: true, org_id: true } },
    },
  })
  if (!claim) throw new Error("Claim not found")
  if (claim.status !== "pending") throw new Error("This claim has already been decided.")

  // A rejection that reaches the claimant with no reason produces an identical
  // re-file, and the queue gets the same row again.
  const trimmed = note?.trim() ?? ""
  if (decision === "reject" && trimmed.length < 10) {
    throw new Error("Give a reason — it is sent to the claimant.")
  }

  if (decision === "approve") {
    /*
     * Re-checked here and not only at file time. Filing and deciding are days
     * apart, and the organisation can have acquired a brand in between — by
     * creating one on `/dashboard/brand`, which needs no approval.
     */
    const owned = await db.sponsors.findFirst({
      where: {
        org_id: claim.org_id,
        deleted_at: null,
        merged_into: null,
        id: { not: claim.sponsor.id },
      },
      select: { name: true, name_key: true },
    })
    if (owned) {
      throw new Error(
        owned.name_key === claim.sponsor.name_key
          ? `That organisation already owns ${owned.name}, which normalises to the same name. Merge the two on the Brands screen instead.`
          : `That organisation already owns ${owned.name}. One brand per organisation — merge them instead.`
      )
    }
  }

  await db.$transaction(async (tx) => {
    await tx.sponsor_claims.update({
      where: { id: claimId },
      data: {
        status: decision === "approve" ? "approved" : "rejected",
        reviewed_by: admin.id,
        reviewed_at: new Date(),
        decision_note: trimmed || null,
      },
    })

    if (decision !== "approve") return

    await tx.sponsors.update({
      where: { id: claim.sponsor.id },
      data: { org_id: claim.org_id, claimed_at: new Date() },
    })

    // One owner per brand, so every other request for it is now moot — and the
    // partial unique index would reject them anyway.
    await tx.sponsor_claims.updateMany({
      where: { sponsor_id: claim.sponsor.id, status: "pending", id: { not: claimId } },
      data: {
        status: "rejected",
        reviewed_by: admin.id,
        reviewed_at: new Date(),
        decision_note: "Another claim on this brand was approved.",
      },
    })
  })

  auditLog({
    userId: admin.id,
    action: decision === "approve" ? "sponsor.claim.approved" : "sponsor.claim.rejected",
    resource: "sponsors",
    resourceId: claim.sponsor.id,
    details: {
      claimId,
      orgId: claim.org_id,
      wasDispute: claim.is_dispute,
      previousOwnerOrgId: claim.sponsor.org_id,
      note: trimmed || null,
    },
  })

  revalidatePath("/dashboard/sponsor-claims")
  revalidatePath("/dashboard/sponsors")
}

export interface MyClaimRow {
  id: string
  brandName: string
  status: "pending" | "approved" | "rejected"
  isDispute: boolean
  decisionNote: string | null
  createdAt: Date
}

/**
 * This organisation's own claims.
 *
 * Rejections are included, and carry their reason. A rejected claim that
 * disappears silently gets re-filed identically, which is the same loop the
 * decision note exists to break.
 */
export async function getMyClaims(): Promise<MyClaimRow[]> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const actor = await actorFor(session.user)
  if (actor.orgIds.length === 0) return []

  const rows = await db.sponsor_claims.findMany({
    where: { org_id: { in: actor.orgIds } },
    select: {
      id: true,
      status: true,
      is_dispute: true,
      decision_note: true,
      created_at: true,
      sponsor: { select: { name: true } },
    },
    orderBy: { created_at: "desc" },
  })

  return rows.map((r) => ({
    id: r.id,
    brandName: r.sponsor.name,
    status: r.status,
    isDispute: r.is_dispute,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
  }))
}
