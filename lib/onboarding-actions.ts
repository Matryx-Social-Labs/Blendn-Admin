"use server"

import crypto from "crypto"
import bcrypt from "bcryptjs"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
import { logger } from "@/lib/logger"
import { validateGstin, gstinMessage } from "@/lib/gstin"
import { emailDomain, isFreeProvider } from "@/lib/org-invites"
import { sendEmail, approvedEmail, declinedEmail, emailConfigured } from "@/lib/email"

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

function generatePassword(length = 14): string {
  return crypto.randomBytes(length).toString("base64url").slice(0, length)
}

async function requireAdmin() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")
  return session.user
}

export interface OnboardingRow {
  id: string
  kind: "individual" | "company"
  requested_role: "organizer" | "venue_owner"
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
  /** Other applications from the same person or company name. */
  relatedCount: number
}

export async function getOnboardingRequests(
  status: "pending" | "approved" | "declined" | "all" = "pending"
): Promise<OnboardingRow[]> {
  await requireAdmin()

  const rows = await db.organiser_onboarding_requests.findMany({
    where:
      status === "all"
        ? {}
        : status === "pending"
          ? { status: { in: ["pending", "email_pending"] } }
          : { status },
    orderBy: { created_at: "desc" },
    take: 200,
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

  return rows.map((r) => {
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
      // Minus itself. More than one is worth a second look, not a refusal.
      relatedCount: (relatedMap.get(r.contact_email) ?? 1) - 1,
    }
  })
}

export interface ApprovalResult {
  email: string
  /** Shown once. If the email did not go out, this is the only copy. */
  password: string
  emailSent: boolean
  orgId: string
}

export async function approveOnboardingRequest(
  requestId: string,
  note?: string
): Promise<ApprovalResult> {
  const admin = await requireAdmin()

  const request = await db.organiser_onboarding_requests.findUnique({ where: { id: requestId } })
  if (!request) throw new Error("Application not found")
  if (request.status === "approved") throw new Error("Already approved")
  if (request.status === "declined") throw new Error("This application was declined")

  const existing = await db.user.findUnique({
    where: { email: request.contact_email },
    select: { id: true, role: true },
  })
  // An attendee applying to host is ordinary — they already use the app. Their
  // account is promoted rather than duplicated, since email is unique.
  if (existing && existing.role !== "attendee") {
    throw new Error("That email already has a host account")
  }

  const password = generatePassword()
  const hashed = await bcrypt.hash(password, 12)

  const { orgId } = await db.$transaction(async (tx) => {
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

    return { orgId: org.id }
  })

  let emailSent = false
  if (emailConfigured()) {
    const result = await sendEmail({
      to: request.contact_email,
      ...approvedEmail(
        request.contact_name,
        request.display_name,
        request.contact_email,
        existing ? "(your existing password)" : password
      ),
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
    password: existing ? "" : password,
    emailSent,
    orgId,
  }
}

export async function declineOnboardingRequest(requestId: string, reason: string): Promise<void> {
  const admin = await requireAdmin()

  // A decline that reaches the applicant with no reason is worse than none —
  // they reapply identically and the queue gets the same row again.
  const trimmed = reason.trim()
  if (trimmed.length < 10) throw new Error("Give a reason — it's sent to the applicant.")

  const request = await db.organiser_onboarding_requests.findUnique({
    where: { id: requestId },
    select: { status: true, contact_email: true, contact_name: true },
  })
  if (!request) throw new Error("Application not found")
  if (request.status === "approved") throw new Error("Already approved — suspend the org instead")

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
  created_at: Date
  memberCount: number
  eventCount: number
  venueCount: number
  domains: { domain: string; verified: boolean }[]
  primaryContact: { name: string | null; email: string } | null
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
      _count: { select: { members: true, events: true, venues: true } },
    },
  })

  return orgs.map((o) => ({
    id: o.id,
    kind: o.kind,
    display_name: o.display_name,
    legal_name: o.legal_name,
    gstin: o.gstin,
    status: o.status,
    created_at: o.created_at,
    memberCount: o._count.members,
    eventCount: o._count.events,
    venueCount: o._count.venues,
    domains: o.domains.map((d) => ({ domain: d.domain, verified: !!d.verified_at })),
    primaryContact: o.members[0]?.user ?? null,
  }))
}

export async function setOrganisationStatus(
  orgId: string,
  status: "pending" | "verified" | "suspended",
  reason?: string
): Promise<void> {
  const admin = await requireAdmin()

  if (status === "suspended" && (reason ?? "").trim().length < 10) {
    throw new Error("Give a reason for suspending an organisation.")
  }

  await db.organisations.update({
    where: { id: orgId },
    data: {
      status,
      ...(status === "verified"
        ? { verified_at: new Date(), verified_by: admin.id }
        : { verified_at: null, verified_by: null }),
    },
  })

  auditLog({
    userId: admin.id,
    action: `organisation.${status}`,
    resource: "organisation",
    resourceId: orgId,
    details: { reason: reason?.trim() || null },
  })

  revalidatePath("/dashboard/organisations")
}
