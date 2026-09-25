"use server"

import { Refusal } from "./refusal"
import crypto from "crypto"
import bcrypt from "bcryptjs"
import { revalidatePath } from "next/cache"
// Type-only: a `"use server"` file may export nothing but async functions,
// and a type import is erased.
import type { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
import { logger } from "@/lib/logger"
import { validateGstin, gstinMessage } from "@/lib/gstin"
import { isAggregatorDomain } from "@/lib/curation-sources"
import { emailDomain, isFreeProvider } from "@/lib/org-invites"
import { sendEmail, approvedEmail, declinedEmail, emailConfigured } from "@/lib/email"
import { issuePasswordResetLink } from "@/lib/password-reset"
import { notifyEventUpdate } from "@/lib/push-notifications"

/**
 * Reviewing host applications.
 *
 * Approval is the moment an application becomes real: it creates the
 * organisation, the user account, and the membership joining them. All three or
 * none — a user with no org is locked out of every screen (authorization
 * resolves on membership), and an org with no members is unreachable.
 *
 * `createRoleUser` in admin-role-actions.ts is deliberately not reused. It
 * exists for an admin adding a host by hand and does its own session check,
 * revalidation, and nothing about organisations; calling it from here would
 * mean a user created outside the transaction that creates the org, which is
 * exactly the half-state to avoid.
 */

/**
 * A new host never receives a password. The account is created with a random
 * one nobody is told, and the approval email carries a single-use link to set
 * their own (SCRUM-134) — the same token the forgot-password flow issues. An
 * email is the least private channel the product uses; the one credential in
 * it should be one that expires and can be used once.
 *
 * A day, not the reset flow's hour: this mail is not one they asked for a
 * minute ago, and the link says how to get another.
 */
const SET_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000

function undisclosedPassword(): string {
  return crypto.randomBytes(32).toString("base64url")
}

async function requireAdmin() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Refusal("Forbidden")
  return session.user
}

export interface OnboardingRow {
  id: string
  kind: "individual" | "company"
  requested_role: "organizer" | "venue_owner" | "sponsor"
  display_name: string
  legal_name: string | null
  gstin: string | null
  website: string | null
  city: string | null
  address: string | null
  contact_name: string
  contact_email: string
  contact_phone: string | null
  tier: "domain" | "needs_proof"
  status: "pending" | "email_pending" | "approved" | "declined"
  email_verified_at: Date | null
  created_at: Date
  /** Derived for the reviewer — never stored, so it cannot go stale. */
  gstinCheck: string | null
  emailDomain: string | null
  freeProvider: boolean
  /**
   * The applicant's address is at a ticketing aggregator.
   *
   * The single most important flag in this queue and it had no rendering at
   * all: `bookings@in.bookmyshow.com` came through in the same filled badge as
   * `founder@thehummingtree.com`, so the strongest negative signal looked
   * identical to the strongest positive one.
   *
   * The curated-events design states the stake plainly — without this check,
   * one address at a ticketing platform could claim every event on the
   * platform.
   */
  aggregatorDomain: boolean
  /** Other applications from the same person or company name. */
  relatedCount: number
}

/**
 * One page of applications, and how many there are.
 *
 * A cap the screen does not mention is the same defect as a count that ignores
 * its filter: the number on screen is not the number that exists, and nothing
 * says so.
 */
const ONBOARDING_PAGE = 200

/** One page of owner candidates. The screen says how many there are. */
const ORG_OPTIONS_PAGE = 200

export async function getOnboardingRequests(
  status: "pending" | "approved" | "declined" | "all" = "pending"
): Promise<{ rows: OnboardingRow[]; total: number }> {
  await requireAdmin()

  const where: Prisma.organiser_onboarding_requestsWhereInput =
    status === "all"
      ? {}
      : status === "pending"
        ? { status: { in: ["pending", "email_pending"] } }
        : { status }

  /*
   * The total, alongside the page.
   *
   * `take: 200` with nothing saying so is a silent cap: an admin who reads two
   * hundred applications and believes that is all of them stops looking, and
   * the ones past the cap are never decided. Same "no silent caps" rule this
   * codebase applies to every bounded backend query, applied to the screen that
   * shows the result.
   */
  const total = await db.organiser_onboarding_requests.count({ where })

  const rows = await db.organiser_onboarding_requests.findMany({
    where,
    orderBy: { created_at: "desc" },
    take: ONBOARDING_PAGE,
  })

  // One grouped query rather than a count per row.
  const emails = [...new Set(rows.map((r) => r.contact_email))]
  const related = emails.length
    ? await db.organiser_onboarding_requests.groupBy({
        by: ["contact_email"],
        where: { contact_email: { in: emails } },
        _count: { id: true },
      })
    : []
  const relatedMap = new Map(related.map((r) => [r.contact_email, r._count.id]))

  const mapped = rows.map((r) => {
    const domain = emailDomain(r.contact_email)
    return {
      id: r.id,
      kind: r.kind as OnboardingRow["kind"],
      requested_role: r.requested_role as OnboardingRow["requested_role"],
      display_name: r.display_name,
      legal_name: r.legal_name,
      gstin: r.gstin,
      website: r.website,
      city: r.city,
      address: r.address,
      contact_name: r.contact_name,
      contact_email: r.contact_email,
      contact_phone: r.contact_phone,
      tier: r.tier as OnboardingRow["tier"],
      status: r.status as OnboardingRow["status"],
      email_verified_at: r.email_verified_at,
      created_at: r.created_at,
      gstinCheck: r.gstin ? gstinMessage(validateGstin(r.gstin)) : null,
      emailDomain: domain,
      freeProvider: domain ? isFreeProvider(domain) : true,
      aggregatorDomain: isAggregatorDomain(domain),
      // Minus itself. More than one is worth a second look, not a refusal.
      relatedCount: (relatedMap.get(r.contact_email) ?? 1) - 1,
    }
  })

  return { rows: mapped, total }
}

export interface ApprovalResult {
  email: string
  /**
   * The set-password link, shown once and only when the email did not go out
   * — then it is the admin who passes it on. Empty for a promoted account,
   * which keeps its password.
   */
  setPasswordLink: string
  emailSent: boolean
  orgId: string
}

export async function approveOnboardingRequest(
  requestId: string,
  note?: string
): Promise<ApprovalResult> {
  const admin = await requireAdmin()

  const request = await db.organiser_onboarding_requests.findUnique({ where: { id: requestId } })
  if (!request) throw new Refusal("Application not found")
  if (request.status === "approved") throw new Refusal("Already approved")
  if (request.status === "declined") throw new Refusal("This application was declined")

  const existing = await db.user.findUnique({
    where: { email: request.contact_email },
    select: { id: true, role: true },
  })
  // An attendee applying to host is ordinary — they already use the app. Their
  // account is promoted rather than duplicated, since email is unique.
  if (existing && existing.role !== "attendee") {
    throw new Refusal("That email already has a host account")
  }

  const hashed = await bcrypt.hash(undisclosedPassword(), 12)

  const { orgId, userId } = await db.$transaction(async (tx) => {
    const org = await tx.organisations.create({
      data: {
        kind: request.kind,
        display_name: request.display_name,
        legal_name: request.legal_name,
        gstin: request.gstin,
        address: request.address,
        website: request.website,
        status: "verified",
        verified_at: new Date(),
        verified_by: admin.id,
        /*
         * A sponsor is granted placement in the same act that approves them.
         *
         * Approving a sponsor application and then requiring a separate
         * `may_sponsor` grant produces an account that is approved and still
         * cannot sponsor — the admin thinks they are done, the sponsor cannot
         * do the one thing they applied for, and nothing anywhere says why.
         *
         * An admin who wants to approve the account WITHOUT the commercial
         * capability revokes it afterwards on the organisations screen, which
         * records a reason. That is the rarer case and it is the one that
         * should take the extra step.
         */
        may_sponsor: request.requested_role === "sponsor",
      },
      select: { id: true },
    })

    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          // The password is NOT reset for an existing account — they already
          // have one, and overwriting it would lock them out of the mobile app
          // mid-session to hand them a credential they did not ask for.
          data: { role: request.requested_role },
          select: { id: true },
        })
      : await tx.user.create({
          data: {
            name: request.contact_name,
            email: request.contact_email,
            password: hashed,
            role: request.requested_role,
          },
          select: { id: true },
        })

    await tx.organisation_members.create({
      data: { org_id: org.id, user_id: user.id, role: "owner", is_primary_contact: true },
    })

    // A company email that reached us verified is already proof of control, so
    // the domain is pre-claimed rather than making them prove it twice. Free
    // providers are skipped — nobody owns gmail.com.
    const domain = emailDomain(request.contact_email)
    if (domain && !isFreeProvider(domain) && request.email_verified_at) {
      // A domain another org already verified must not be stolen by approval.
      const taken = await tx.organisation_domains.findUnique({ where: { domain } })
      if (!taken) {
        await tx.organisation_domains.create({
          data: {
            org_id: org.id,
            domain,
            method: "email_role",
            verification_token: "",
            verified_at: new Date(),
            verified_by: admin.id,
          },
        })
      }
    }

    await tx.organiser_onboarding_requests.update({
      where: { id: requestId },
      data: {
        status: "approved",
        reviewed_by: admin.id,
        reviewed_at: new Date(),
        review_note: note?.trim() || null,
        org_id: org.id,
      },
    })

    return { orgId: org.id, userId: user.id }
  })

  const setPasswordLink = existing ? "" : await issuePasswordResetLink(userId, SET_PASSWORD_TTL_MS)

  let emailSent = false
  if (emailConfigured()) {
    const result = await sendEmail({
      to: request.contact_email,
      ...approvedEmail(request.contact_name, request.display_name, request.contact_email, setPasswordLink || null),
    })
    emailSent = result.sent
    if (!result.sent) {
      logger.error("Approval email failed", { requestId, reason: result.reason })
    }
  }

  auditLog({
    userId: admin.id,
    action: "onboarding.approved",
    resource: "organiser_onboarding_request",
    resourceId: requestId,
    details: {
      orgId,
      role: request.requested_role,
      promotedExisting: !!existing,
      emailSent,
      note: note?.trim() || null,
    },
  })

  revalidatePath("/dashboard/onboarding")
  revalidatePath("/dashboard/organisations")
  revalidatePath("/dashboard/organisers")
  revalidatePath("/dashboard/venue-owners")

  return {
    email: request.contact_email,
    // Once it has gone out, the browser tab has no business holding it.
    setPasswordLink: emailSent ? "" : setPasswordLink,
    emailSent,
    orgId,
  }
}

export async function declineOnboardingRequest(requestId: string, reason: string): Promise<void> {
  const admin = await requireAdmin()

  // A decline that reaches the applicant with no reason is worse than none —
  // they reapply identically and the queue gets the same row again.
  const trimmed = reason.trim()
  if (trimmed.length < 10) throw new Refusal("Give a reason — it's sent to the applicant.")

  const request = await db.organiser_onboarding_requests.findUnique({
    where: { id: requestId },
    select: { status: true, contact_email: true, contact_name: true },
  })
  if (!request) throw new Refusal("Application not found")
  if (request.status === "approved") throw new Refusal("Already approved — suspend the org instead")

  await db.organiser_onboarding_requests.update({
    where: { id: requestId },
    data: {
      status: "declined",
      decline_reason: trimmed,
      reviewed_by: admin.id,
      reviewed_at: new Date(),
    },
  })

  if (emailConfigured()) {
    const result = await sendEmail({
      to: request.contact_email,
      ...declinedEmail(request.contact_name, trimmed),
    })
    if (!result.sent) logger.error("Decline email failed", { requestId, reason: result.reason })
  }

  auditLog({
    userId: admin.id,
    action: "onboarding.declined",
    resource: "organiser_onboarding_request",
    resourceId: requestId,
    details: { reason: trimmed },
  })

  revalidatePath("/dashboard/onboarding")
}

/* -------------------------------------------------------------------------- */
/* Platform organisations screen                                               */
/* -------------------------------------------------------------------------- */

export interface OrgSummary {
  id: string
  kind: string
  display_name: string
  legal_name: string | null
  gstin: string | null
  status: string
  may_sponsor: boolean
  created_at: Date
  memberCount: number
  eventCount: number
  venueCount: number
  domains: { domain: string; verified: boolean }[]
  primaryContact: { name: string | null; email: string } | null
}

/**
 * Just enough to fill a picker: id and name.
 *
 * Separate from `getOrganisations`, which loads domains, members and three
 * counts per row for the organisations screen. A select element needs none of
 * that, and reusing the heavy one would make choosing an owner cost the same as
 * rendering the whole directory.
 *
 * Capped, and the total comes back with it, so the screen can say the list is a
 * page rather than implying it is the platform.
 */
export async function organisationOptions(): Promise<{
  rows: { id: string; name: string }[]
  total: number
}> {
  await requireAdmin()

  const [rows, total] = await Promise.all([
    db.organisations.findMany({
      orderBy: { display_name: "asc" },
      take: ORG_OPTIONS_PAGE,
      select: { id: true, display_name: true },
    }),
    db.organisations.count(),
  ])
  return { rows: rows.map((o) => ({ id: o.id, name: o.display_name })), total }
}

export async function getOrganisations(): Promise<OrgSummary[]> {
  await requireAdmin()

  const orgs = await db.organisations.findMany({
    orderBy: { created_at: "desc" },
    include: {
      domains: { select: { domain: true, verified_at: true } },
      members: {
        where: { is_primary_contact: true },
        take: 1,
        select: { user: { select: { name: true, email: true } } },
      },
      /*
       * What the organisation runs, not every row it ever had. A bare `events:
       * true` counts soft-deleted rows too: Nightshift read "39 events" while
       * running 26 (SCRUM-167). The organisations CSV in lib/reports.ts asks
       * the same question and carries the same filter.
       */
      _count: {
        select: {
          members: true,
          events: { where: { deleted_at: null } },
          venues: { where: { deleted_at: null } },
        },
      },
    },
  })

  return orgs.map((o) => ({
    id: o.id,
    kind: o.kind,
    display_name: o.display_name,
    legal_name: o.legal_name,
    gstin: o.gstin,
    status: o.status,
    // The admin grant reads this; without it the control cannot render its
    // current state and would default to "not granted" for everyone.
    may_sponsor: o.may_sponsor,
    created_at: o.created_at,
    memberCount: o._count.members,
    eventCount: o._count.events,
    venueCount: o._count.venues,
    domains: o.domains.map((d) => ({ domain: d.domain, verified: !!d.verified_at })),
    primaryContact: o.members[0]?.user ?? null,
  }))
}

/**
 * Suspending an organisation means something (SCRUM-8).
 *
 * It used to change a badge: `actorFor` never looked at org status and every
 * published event stayed listed to every phone. Two things happen now, in one
 * transaction:
 *
 *  - the org's published events flip to `draft`, remembering what they were
 *    in `pre_suspension_status`. Every attendee surface already hides a draft
 *    — lists, search, GET, RSVP, the door, reminder pushes, the room — so
 *    nothing has to be re-derived per surface. RSVPs and check-ins are left
 *    where they are for the reinstatement;
 *  - `activeMembership` stops loading the membership, so every dashboard door
 *    closes and the org page says why.
 *
 * Reinstating flips back only rows still `draft` with the memory set: an
 * admin who cancelled one of them meanwhile wins.
 *
 * People who had said they were going to something now hidden are told once,
 * after the commit, through the same channel an announcement uses.
 */
export async function setOrganisationStatus(
  orgId: string,
  status: "pending" | "verified" | "suspended",
  reason?: string
): Promise<void> {
  const admin = await requireAdmin()

  const trimmed = reason?.trim() || null
  if (status === "suspended" && (trimmed ?? "").length < 10) {
    throw new Refusal("Give a reason for suspending an organisation.")
  }

  const hidden = await db.$transaction(async (tx) => {
    await tx.organisations.update({
      where: { id: orgId },
      data: {
        status,
        ...(status === "verified"
          ? { verified_at: new Date(), verified_by: admin.id }
          : { verified_at: null, verified_by: null }),
        ...(status === "suspended"
          ? { suspended_at: new Date(), suspension_reason: trimmed }
          : { suspended_at: null, suspension_reason: null }),
      },
    })

    if (status === "suspended") {
      const events = await tx.events.findMany({
        where: { organizer_org_id: orgId, status: "published", deleted_at: null },
        select: { id: true, title: true, end_time: true },
      })
      await tx.events.updateMany({
        where: { id: { in: events.map((e) => e.id) } },
        data: { status: "draft", pre_suspension_status: "published" },
      })
      return events
    }

    await tx.events.updateMany({
      where: { organizer_org_id: orgId, status: "draft", pre_suspension_status: "published", deleted_at: null },
      data: { status: "published", pre_suspension_status: null },
    })
    return []
  })

  auditLog({
    userId: admin.id,
    action: `organisation.${status}`,
    resource: "organisation",
    resourceId: orgId,
    details: { reason: trimmed, eventsHidden: hidden.length },
  })

  // After the commit: a push about a hidden event must never precede the
  // hiding. Anything not yet over — including a room people are standing in
  // right now, which has just closed under them.
  const now = new Date()
  for (const event of hidden.filter((e) => e.end_time > now)) {
    const going = await db.event_rsvps.findMany({
      where: { event_id: event.id, status: { in: ["going", "maybe", "waitlisted"] } },
      select: { user_id: true },
    })
    if (going.length === 0) continue
    await notifyEventUpdate(
      going.map((r) => r.user_id),
      event.title,
      "This event is no longer available.",
      event.id
    ).catch((err) =>
      logger.error("Suspension notice failed", { eventId: event.id, error: err instanceof Error ? err.message : String(err) })
    )
  }

  revalidatePath("/dashboard/organisations")
}

/**
 * Grant or revoke an organisation's right to sell placement.
 *
 * `organisations.may_sponsor` shipped in #259 with one reader and **zero
 * writers**. The gate was correct in the deny direction and no screen could
 * turn it on, so the commercial model the feature was built for was
 * unsellable — both directions wrong at once.
 *
 * Admin-only and deliberately not self-serve: the flag represents a commercial
 * agreement, and "sponsored" is a claim that somebody paid. If an organiser
 * could grant it to themselves the word stops meaning anything and becomes a
 * styling choice.
 *
 * Granting asks for a reason for the same purpose suspension does — the
 * agreement lives outside this system, and six months later the audit row is
 * the only record of which one.
 *
 * Revoking does NOT stop campaigns already running. `may_sponsor` gates the
 * WRITE path (`canBroadcast`), not the scheduler, and silently killing live
 * placements an organiser has paid for is not a decision this toggle should
 * make on its own. Cancel the placements to stop the sends.
 */
export async function setOrganisationMaySponsor(
  orgId: string,
  maySponsor: boolean,
  reason?: string
): Promise<void> {
  const admin = await requireAdmin()

  if ((reason ?? "").trim().length < 10) {
    throw new Refusal(
      maySponsor
        ? "Record which agreement this grant is under."
        : "Give a reason for revoking sponsorship access."
    )
  }

  const org = await db.organisations.findUnique({
    where: { id: orgId },
    select: { id: true, status: true, display_name: true },
  })
  if (!org) throw new Refusal("Organisation not found")

  /*
   * A suspended organisation cannot be granted placement.
   *
   * Suspension is how an organisation is stopped; handing it a paid capability
   * in that state would be the two controls contradicting each other, with
   * whichever was clicked last winning.
   */
  if (maySponsor && org.status !== "verified") {
    throw new Refusal("Only a verified organisation can be granted sponsorship access")
  }

  await db.organisations.update({ where: { id: orgId }, data: { may_sponsor: maySponsor } })

  auditLog({
    userId: admin.id,
    action: maySponsor ? "organisation.may_sponsor.grant" : "organisation.may_sponsor.revoke",
    resource: "organisation",
    resourceId: orgId,
    details: { reason: reason?.trim() ?? null, orgName: org.display_name },
  })

  revalidatePath("/dashboard/organisations")
}
