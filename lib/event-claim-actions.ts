"use server"

import { headers } from "next/headers"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { claimFlags, type ClaimFlag } from "@/lib/claim-flags"
import { CLAIM_LIMITS, CLAIM_PAGE, claimRefusal, curationSelect } from "@/lib/curation"
import { db } from "@/lib/db"
import { violatedConstraint } from "@/lib/prisma-errors"
import { owningOrgFor } from "@/lib/event-ownership"
import { logger } from "@/lib/logger"
import { hit } from "@/lib/rate-limit-store"

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
  /**
   * The onboarding request that will become the claimant's organisation.
   *
   * Accepted from the caller, unlike an org id, because an onboarding request
   * **grants nothing** — it is itself pending review, and the admin deciding
   * the claim sees both. An organisation id is the opposite: it names a real
   * owner that already exists, so it is derived from the session below and
   * never read from input. Attaching a stranger's claim to somebody else's
   * organisation is not a thing this function should be able to express.
   */
  onboardingId?: string
}

const HOUR_MS = 60 * 60 * 1000

/**
 * Three windows, checked together, Redis-backed.
 *
 * `lib/rate-limit.ts` wraps this for route handlers and needs a `NextRequest`;
 * a server action has no request object, so it calls `hit()` directly rather
 * than growing a second limiter — the counter, the store and the Redis
 * fallback are all the same ones every rate-limited route already uses.
 *
 * Returns the message to refuse with, or null to proceed.
 */
async function overClaimLimit(email: string, eventId: string): Promise<string | null> {
  /*
   * `x-forwarded-for` is spoofable, which is why it is the weakest of the three
   * and never the only one. Behind Railway's proxy the left-most entry is the
   * real client; with no header at all every anonymous caller shares one
   * bucket, which fails toward refusing rather than toward letting through.
   */
  const forwarded = (await headers()).get("x-forwarded-for") ?? "unknown"
  const ip = forwarded.split(",")[0]!.trim() || "unknown"

  const [byEmail, byEvent, byIp] = await Promise.all([
    hit(`rl:claim:email:${email}`, HOUR_MS),
    hit(`rl:claim:event:${eventId}`, HOUR_MS),
    hit(`rl:claim:ip:${ip}`, HOUR_MS),
  ])

  if (byEmail.count > CLAIM_LIMITS.perEmailPerHour || byIp.count > CLAIM_LIMITS.perIpPerHour) {
    return "You have filed several claims recently. Give us a little time to read them."
  }
  if (byEvent.count > CLAIM_LIMITS.perEventPerHour) {
    // Deliberately the same sentence. Telling a flooder which bucket they hit
    // tells them which one to vary.
    return "You have filed several claims recently. Give us a little time to read them."
  }
  return null
}

export async function fileEventClaim(
  input: FileClaimInput
): Promise<{ ok: true; claimId: string } | { ok: false; error: string }> {
  /*
   * Deliberately not authenticated — but not unbounded, and not trusting.
   *
   * Most claims arrive from somebody with no account: that is *why* the event
   * was curated. Requiring a login here would put a signup wall in front of
   * the acquisition funnel. What protects it instead is that filing costs
   * nothing and grants nothing, plus the two things the eng review found
   * missing — a rate limit, and refusing to let the caller name the
   * organisation the claim is filed for.
   */
  const email = input.contactEmail.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Give an email address we can reply to" }
  }

  /*
   * The organisation comes from the session or from an onboarding request.
   * Never from input.
   *
   * `owningOrgFor` throws for a signed-in user with no membership, which is a
   * broken onboarding rather than a claim problem — so it is caught and read
   * as "you have no organisation yet", and they take the no-account path.
   */
  const session = await getAuth()
  let orgId: string | null = null
  if (session?.user && session.user.role !== "app_admin") {
    try {
      orgId = await owningOrgFor(session.user)
    } catch {
      orgId = null
    }
  }

  /*
   * An application id from the browser has to be the caller's own.
   *
   * A pending application grants nothing, which is why accepting the id was
   * safe — until the hand-over started resolving the organisation from an
   * *approved* one. Without this check anyone who knew a request's uuid could
   * file a claim on any event under any email and have it handed to that
   * organisation. The request's contact address must be the claim's.
   */
  if (input.onboardingId) {
    const request = await db.organiser_onboarding_requests.findUnique({
      where: { id: input.onboardingId },
      select: { contact_email: true },
    })
    if (!request || request.contact_email.toLowerCase() !== email) {
      return { ok: false, error: "That application does not match this email address" }
    }
  }

  if (Boolean(orgId) === Boolean(input.onboardingId)) {
    return {
      ok: false,
      error: orgId
        ? "You are signed in with an organisation, so this claim does not need an application"
        : "Tell us about your organisation first, so there is something to hand the event to",
    }
  }

  const limited = await overClaimLimit(email, input.eventId)
  if (limited) return { ok: false, error: limited }

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
    orgId
      ? db.organisation_domains.findMany({
          where: { org_id: orgId, verified_at: { not: null } },
          select: { domain: true },
        })
      : Promise.resolve([]),
  ])

  const flags = claimFlags({
    contactEmail: email,
    sourceUrl: event.source_url,
    verifiedDomains: verified.map((d) => d.domain.toLowerCase()),
    priorClaims,
    withoutOrg: !orgId,
  })

  try {
    const claim = await db.event_claims.create({
      data: {
        event_id: event.id,
        org_id: orgId,
        onboarding_id: input.onboardingId ?? null,
        contact_email: email,
        note: input.note?.trim() || null,
        flags,
      },
      select: { id: true },
    })

    logger.info("Event claim filed", { eventId: event.id, claimId: claim.id, flags })
    /*
     * The flags stay here.
     *
     * They used to come back to the caller, which -- on an unauthenticated
     * endpoint -- is an oracle: submit an address, read back whether it matches
     * a verified domain. They are evidence for the reviewer, not feedback for
     * the claimant, and telling a claimant which signal they failed is telling
     * them what to forge next.
     */
    return { ok: true, claimId: claim.id }
  } catch (error) {
    /*
     * The partial unique indexes refuse a second PENDING claim from the same
     * claimant. Re-filing after a decision is allowed and creates a new row --
     * that is the count a reviewer needs -- so this is only ever "you already
     * asked and we have not answered yet".
     */
    /*
     * `violatedConstraint`, not `message.includes(...)`. Prisma's message names
     * the violated fields and never the index, so the obvious check never
     * matched and this returned the generic failure below for every duplicate.
     */
    const message = error instanceof Error ? error.message : String(error)
    if (violatedConstraint(error, "event_claims_one_pending")) {
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
      onboarding_id: true,
      contact_email: true,
      event: { select: { id: true, title: true, ...curationSelect } },
    },
  })
  if (!claim) throw new Error("Claim not found")
  if (claim.status !== "pending") throw new Error("This claim has already been decided.")

  /*
   * A claim filed without an account carries `onboarding_id` and no `org_id`;
   * approving that application creates the organisation and records it on the
   * request — and nothing wrote it back to the claim. So the funnel's second
   * half dead-ended: the queue said "approving creates the organisation
   * first", the action said "approve the onboarding request first", and after
   * doing so the hand-over still refused, for ever. Found by handing over the
   * seeded no-account claim. The organisation is resolved from the request
   * here, at decision time.
   */
  const request = claim.onboarding_id
    ? await db.organiser_onboarding_requests.findUnique({
        where: { id: claim.onboarding_id },
        select: { org_id: true, contact_email: true },
      })
    : null
  // Filing already refused a request that is not the claimant's own; checked
  // again here because this is the write that hands over an event, and a
  // read at filing time is not a guarantee at decision time.
  if (request && request.contact_email.toLowerCase() !== claim.contact_email.toLowerCase()) {
    throw new Error("The application on this claim belongs to a different email address.")
  }
  const orgId = claim.org_id ?? request?.org_id ?? null

  // A decline with no reason produces an identical re-file, and the queue gets
  // the same row again. Same rule as the venue queue.
  const trimmed = note?.trim() ?? ""
  if (decision === "decline" && trimmed.length < 10) {
    throw new Error("Give a reason — it is sent to the claimant.")
  }

  if (decision === "approve") {
    if (!orgId) {
      throw new Error(
        "Approve their application first — there is no organisation to hand this to yet."
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

  /*
   * The race the check above cannot close.
   *
   * `claimRefusal` is a read, and a read outside a transaction is not a lock:
   * two admins with the queue open both see `claimed_at IS NULL`, both pass,
   * and both commit -- two rows saying `approved`, the event belonging to
   * whichever committed last, and a second organisation told they got it.
   * `event_claims_one_approved_per_event` is what actually serialises it, so
   * the loser lands in the catch. H13 in the register, closed rather than
   * inherited for the third instance of this pattern.
   */
  try {
    await db.$transaction(async (tx) => {
      await tx.event_claims.update({
        where: { id: claimId },
        data: {
          status: decision === "approve" ? "approved" : "declined",
          reviewed_by: admin.id,
          reviewed_at: new Date(),
          decision_note: trimmed || null,
          // Recorded on the claim too, so the row says who got the event.
          // `event_claims_one_claimant` wants exactly one of the pair set, so
          // the request id goes as the organisation arrives.
          ...(decision === "approve" && !claim.org_id && orgId
            ? { org_id: orgId, onboarding_id: null }
            : {}),
        },
      })

      if (decision !== "approve") return

      // The one write that unlocks every screen.
      await tx.events.update({
        where: { id: claim.event.id },
        data: { organizer_org_id: orgId, claimed_at: new Date() },
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
  } catch (error) {
    if (violatedConstraint(error, "event_claims_one_approved_per_event")) {
      throw new Error("Somebody else's claim was approved first.")
    }
    throw error
  }

  auditLog({
    userId: admin.id,
    action: decision === "approve" ? "event_claim.approved" : "event_claim.declined",
    resource: "event_claim",
    resourceId: claimId,
    details: { eventId: claim.event.id, title: claim.event.title, orgId },
  })
}

export interface EventClaimRow {
  id: string
  eventId: string
  eventTitle: string
  eventCity: string | null
  eventStartsAt: string
  /** The listing it was curated from, so a reviewer can open it. */
  sourceUrl: string | null
  /** Null when the claimant has no account yet. */
  orgName: string | null
  contactEmail: string
  note: string | null
  flags: ClaimFlag[]
  /** How many times this event has been claimed, including this one. */
  claimNumber: number
  createdAt: string
  /** Hours waiting. Age is the SLA, same as the moderation queue. */
  ageHours: number
  /** Why it cannot be decided right now, if so. */
  blocked: "room_open" | "already_claimed" | null
}

/**
 * The queue, oldest first.
 *
 * Age is the SLA — the same rule the moderation queue states and for the same
 * reason. A claimant waiting on an answer is an organiser deciding whether this
 * platform is worth their time, and newest-first would bury exactly the ones
 * who have been waiting longest.
 */
export async function getEventClaimQueue(): Promise<{ rows: EventClaimRow[]; total: number }> {
  const session = await getAuth()
  /*
   * The read half is gated too, not only the decide half.
   *
   * This returns contact email addresses and free-text notes for every pending
   * claim on the platform. The moderation queue had exactly this gap -- the page
   * redirected non-admins and the action that returned the sensitive data did
   * not -- and it is the half that actually serves the data.
   */
  if (session?.user?.role !== "app_admin") throw new Error("Not authorised")

  // The total alongside the page, so a capped queue can say it is capped.
  const total = await db.event_claims.count({ where: { status: "pending" } })

  const claims = await db.event_claims.findMany({
    where: { status: "pending" },
    orderBy: { created_at: "asc" },
    take: CLAIM_PAGE,
    select: {
      id: true,
      contact_email: true,
      note: true,
      flags: true,
      created_at: true,
      org: { select: { display_name: true } },
      event: {
        select: {
          id: true,
          title: true,
          city: true,
          source_url: true,
          // Carries start_time and end_time, which claimRefusal needs.
          ...curationSelect,
        },
      },
    },
  })

  // One grouped query rather than a count per row: the number of prior claims
  // is the reviewer's most useful fact and should not cost N round trips.
  const counts = await db.event_claims.groupBy({
    by: ["event_id"],
    where: { event_id: { in: claims.map((c) => c.event.id) } },
    _count: { _all: true },
  })
  const claimsPerEvent = new Map(counts.map((c) => [c.event_id, c._count._all]))

  const now = Date.now()
  const rows = claims.map((c) => {
    const refusal = claimRefusal(c.event)
    return {
      id: c.id,
      eventId: c.event.id,
      eventTitle: c.event.title,
      eventCity: c.event.city,
      eventStartsAt: c.event.start_time.toISOString(),
      sourceUrl: c.event.source_url,
      orgName: c.org?.display_name ?? null,
      contactEmail: c.contact_email,
      note: c.note,
      flags: Array.isArray(c.flags) ? (c.flags as ClaimFlag[]) : [],
      claimNumber: claimsPerEvent.get(c.event.id) ?? 1,
      createdAt: c.created_at.toISOString(),
      ageHours: Math.floor((now - c.created_at.getTime()) / (60 * 60 * 1000)),
      /*
       * Surfaced rather than discovered on submit.
       *
       * `decideEventClaim` re-checks this and throws, which is correct and is a
       * terrible way to learn it. A reviewer working a queue should see that a
       * row cannot be actioned yet before they read it, not after they decide.
       */
      blocked: refusal === "not_curated" ? null : refusal,
    }
  })

  return { rows, total }
}
