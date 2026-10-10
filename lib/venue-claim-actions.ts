"use server"

import { Refusal } from "./refusal"
import { cancelPreviousOwnersMandates, endPreviousOwnersPro } from "./subscription-cancel"
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
import { emailDomain, isFreeProvider, normaliseDomain } from "@/lib/org-invites"
import { isUuid } from "@/lib/api-input"
import { overClaimLimit } from "@/lib/claim-limit"
import { claimEmail, claimInputRefusal, claimVenueInput } from "@/lib/claim-input"
import { claimVenueWhere } from "@/lib/curation"
import { violatedConstraint } from "@/lib/prisma-errors"
import { logger } from "@/lib/logger"
import { realEventsWhere } from "@/lib/event-kind"

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
  raw: FilePublicVenueClaimInput
): Promise<{ ok: true; claimId: string } | { ok: false; error: string }> {
  // Unauthenticated: the argument is whatever a client sent, so it is parsed
  // and every string capped before anything reads it (lib/claim-input.ts).
  const parsed = claimVenueInput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: claimInputRefusal(parsed.error) }
  const input = parsed.data

  // venues.id is a UUID column; a malformed id is a missing venue, not a throw.
  if (!isUuid(input.venueId)) return { ok: false, error: "Venue not found" }
  const email = claimEmail(input.contactEmail)
  if (!email) return { ok: false, error: "Give an email address we can reply to" }

  // Before any lookup, so a failed attempt is metered as much as a filed one.
  const limited = await overClaimLimit(email, { kind: "venue", id: input.venueId })
  if (limited) return { ok: false, error: limited }

  /*
   * The application has to be this address's own, a venue owner's, and not
   * already declined.
   *
   * Approval resolves the organisation from it, so a uuid that names somebody
   * else's application would hand the venue to them. And an organiser cannot
   * claim a venue from the dashboard (`fileVenueClaim`), so an organiser's
   * application cannot do it from here either.
   */
  const request = isUuid(input.onboardingId)
    ? await db.organiser_onboarding_requests.findUnique({
        where: { id: input.onboardingId },
        select: { contact_email: true, requested_role: true, status: true },
      })
    : null
  if (!request || request.contact_email.toLowerCase() !== email) {
    return { ok: false, error: "That application does not match this email address" }
  }
  if (request.requested_role !== "venue_owner") {
    return { ok: false, error: "That application is not for a venue" }
  }
  if (request.status === "declined") {
    return { ok: false, error: "That application was declined, so there is nothing to file this claim against" }
  }

  const givenGstin = input.gstin?.trim().toUpperCase() || null
  if (givenGstin) {
    const result = validateGstin(givenGstin)
    if (!result.valid) return { ok: false, error: gstinMessage(result) }
  }

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
   * gave, with `waitingOn` set.
   */
  orgName: string
  filedByName: string | null
  /** Who to write back to, for a claim filed with no account. */
  contactEmail: string | null
  note: string | null
  /**
   * Why a claim filed with no account cannot be approved yet, if so: its
   * address is unconfirmed (`email`), or its application is not approved, so
   * there is no organisation to hand the venue to (`application`).
   * `decideVenueClaim` refuses both; the card says so before the buttons
   * rather than after a failed submit.
   */
  waitingOn: "email" | "application" | null
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

/**
 * What to weigh about a claim filed with no account, where all the reviewer has
 * is what a stranger typed.
 */
function noAccountFlags(contactEmail: string | null, website: string | null, gstin: string | null): string[] {
  const flags: string[] = []
  const domain = contactEmail ? emailDomain(contactEmail) : null
  if (domain && isFreeProvider(domain)) {
    flags.push(`Filed from a free email address (${domain}), not one at the venue's own domain`)
  }
  const site = website ? normaliseDomain(website) : null
  if (domain && site && !isFreeProvider(domain) && domain !== site) {
    flags.push(`Email domain ${domain} does not match the website they gave (${site})`)
  }
  if (gstin) flags.push("GSTIN passes its checksum only — check the registered address is this venue's")
  return flags
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
          _count: { select: { events: { where: { deleted_at: null, ...realEventsWhere } } } },
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
        select: {
          id: true,
          display_name: true,
          website: true,
          email_verified_at: true,
          org: { select: { display_name: true } },
        },
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
    const waitingOn =
      c.onboarding_id && !request?.email_verified_at ? "email" : approvedOrg === null ? "application" : null

    if (!evidence.tradeLicence) flags.push("No trade licence attached")
    if (!c.filed_by) flags.push(...noAccountFlags(c.contact_email, request?.website ?? null, c.gstin))
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
      waitingOn,
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
  if (claim.status !== "pending") throw new Refusal(ALREADY_DECIDED)

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
        select: { org_id: true, contact_email: true, email_verified_at: true },
      })
    : null
  if (request && request.contact_email.toLowerCase() !== (claim.contact_email ?? "").toLowerCase()) {
    throw new Refusal("The application on this claim belongs to a different email address.")
  }
  const orgId = claim.org_id ?? request?.org_id ?? null
  if (decision === "approve") refuseUnsafeApproval(claim, request, orgId)
  if (decision === "approve" && !claim.org_id && orgId) {
    // The organisation may already have a claim of its own on this venue (filed
    // from its dashboard once the account existed); one row per pair.
    const own = await db.venue_claims.findFirst({
      where: { venue_id: claim.venue.id, org_id: orgId, id: { not: claimId } },
      select: { id: true },
    })
    if (own) throw new Refusal(ORG_ALREADY_CLAIMED)
  }

  // Read before the write: after it, nobody is pending any more.
  const losers =
    decision === "approve"
      ? await db.venue_claims.findMany({
          where: { venue_id: claim.venue.id, status: "pending", id: { not: claimId } },
          select: { filed_by: true, contact_email: true, onboarding_id: true },
        })
      : []

  try {
    await db.$transaction(async (tx) => {
      /*
       * Guarded writes, not reads then writes: two reviewers deciding at once
       * both pass the checks above, so the transaction is what decides. Only a
       * still-pending claim is decided, and only an unowned venue (or one the
       * same organisation owns) is handed over unless this is a dispute.
       */
      const decided = await tx.venue_claims.updateMany({
        where: { id: claimId, status: "pending" },
        data: {
          status: decision === "approve" ? "approved" : "declined",
          reviewed_by: admin.id,
          reviewed_at: new Date(),
          decision_note: trimmed || null,
          // The row says who got the venue. `venue_claims_one_claimant` wants
          // exactly one of the pair, so the application goes as the
          // organisation arrives.
          ...(decision === "approve" && !claim.org_id ? { org_id: orgId, onboarding_id: null } : {}),
        },
      })
      if (decided.count !== 1) throw new Refusal(ALREADY_DECIDED)

      if (decision !== "approve" || !orgId) return

      const handed = await tx.venues.updateMany({
        where: {
          id: claim.venue.id,
          ...(claim.is_dispute ? {} : { OR: [{ owner_org_id: null }, { owner_org_id: orgId }] }),
        },
        data: { owner_org_id: orgId, claimed_at: new Date() },
      })
      if (handed.count !== 1) throw new Refusal(OWNER_SINCE_FILING)
      // Whoever paid for Pro here before does not hand it over with the venue:
      // it ends in this transaction, with the transfer or not at all (review M7).
      await endPreviousOwnersPro(tx, claim.venue.id, orgId, admin.id)

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
  } catch (error) {
    // The pre-check above, lost to a concurrent filing.
    if (violatedConstraint(error, "venue_claims_venue_id_org_id_key")) throw new Refusal(ORG_ALREADY_CLAIMED)
    throw error
  }

  // And their mandate stops at Razorpay, now the transfer has committed.
  if (decision === "approve" && orgId) await cancelPreviousOwnersMandates(claim.venue.id, orgId, admin.id)

  const notified = await tellVenueClaimants(
    { ...claim, verified: Boolean(request?.email_verified_at) },
    decision,
    trimmed || null,
    await withVerification(losers)
  )

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

const ALREADY_DECIDED = "This claim has already been decided."
const OWNER_SINCE_FILING =
  "This venue has been given an owner since the claim was filed. Decline it, or have them dispute it from the dashboard."
const ORG_ALREADY_CLAIMED =
  "That organisation already has its own claim on this venue. Decide that one instead — if it was declined, they can re-file it from their dashboard."

/**
 * The approvals refused before anything is written, each a fact the queue
 * also shows before the buttons.
 */
function refuseUnsafeApproval(
  claim: { onboarding_id: string | null; is_dispute: boolean; venue: { owner_org_id: string | null } },
  request: { email_verified_at: Date | null } | null,
  orgId: string | null
): void {
  /*
   * A no-account claim stands on an application whose address nobody has
   * proved yet: the apply route sends a link and does not wait for it, and an
   * application can be approved before it is clicked. Handing a venue to an
   * address a stranger typed is the false claim this queue exists to stop.
   */
  if (claim.onboarding_id && !request?.email_verified_at) {
    throw new Refusal("Their email address is not confirmed yet. Approve once they have clicked the link we sent.")
  }
  if (!orgId) {
    throw new Refusal("Approve their application first — there is no organisation to hand this venue to yet.")
  }
  /*
   * An owner given since filing (`assignVenueOwner`, or a claim decided
   * elsewhere) would be overwritten by an approval the reviewer reads as a
   * plain claim: `is_dispute` was fixed at filing, so the card shows neither
   * the incumbent nor "Transfer venue". The transaction re-checks this.
   */
  if (!claim.is_dispute && claim.venue.owner_org_id !== null && claim.venue.owner_org_id !== orgId) {
    throw new Refusal(OWNER_SINCE_FILING)
  }
}

interface Claimant {
  filed_by: string | null
  contact_email: string | null
  /** For a no-account claimant: whether their application's address is confirmed. */
  verified?: boolean
}

/** Losers filed without an account, marked with whether their address is confirmed. */
async function withVerification(
  losers: { filed_by: string | null; contact_email: string | null; onboarding_id: string | null }[]
): Promise<Claimant[]> {
  const ids = losers.flatMap((l) => (l.onboarding_id ? [l.onboarding_id] : []))
  const confirmed = ids.length
    ? new Set(
        (
          await db.organiser_onboarding_requests.findMany({
            where: { id: { in: ids }, email_verified_at: { not: null } },
            select: { id: true },
          })
        ).map((r) => r.id)
      )
    : new Set<string>()
  return losers.map((l) => ({ ...l, verified: l.onboarding_id ? confirmed.has(l.onboarding_id) : false }))
}

/** The decided claimant hears the reason; on an approval so do the ones it displaced. */
async function tellVenueClaimants(
  claim: Claimant & { venue: { name: string } },
  decision: "approve" | "decline",
  reason: string | null,
  losers: Claimant[]
): Promise<boolean> {
  const who = await claimants([claim, ...losers].flatMap((c) => (c.filed_by ? [c.filed_by] : [])))
  /*
   * An account holder is reached through their user. Somebody with no account
   * only through the address they filed with, and only once they have proved
   * it is theirs: an unconfirmed address is whatever a stranger typed, and a
   * decision mail to it would be ours, sent to somebody else.
   */
  const addressOf = (c: Claimant) =>
    (c.filed_by ? who.get(c.filed_by) : undefined) ??
    (c.contact_email && c.verified ? { email: c.contact_email, name: null } : undefined)
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
