"use server"

import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
import { logger } from "@/lib/logger"
import { orgPermissions } from "@/lib/org-permissions"
import {
  hashInviteToken,
  newInviteToken,
  invitePolicy,
  normaliseDomain,
  emailDomain,
  isFreeProvider,
} from "@/lib/org-invites"
import {
  checkDomainTxt,
  isRoleAddressFor,
  newDomainToken,
  txtInstructions,
  roleAddressesFor,
} from "@/lib/domain-verify"
import {
  sendEmail,
  inviteEmail,
  appUrl,
  domainVerifyEmail,
  emailConfigured,
} from "@/lib/email"
import type { org_role } from "@prisma/client"

/**
 * An organisation managing itself: members, invites, domains, join requests.
 *
 * Every function here resolves the caller's own membership first. A platform
 * admin is *not* silently granted org management — they get their own screen
 * for that. Letting `app_admin` fall through here would mean a support action
 * recorded as though the org's owner did it.
 */

/** The caller's membership of one org, or a throw. */
async function requireOrgRole(
  orgId: string,
  check: (p: ReturnType<typeof orgPermissions>) => boolean
) {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const membership = await db.organisation_members.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: session.user.id } },
    select: { role: true },
  })
  if (!membership) throw new Error("Forbidden")
  if (!check(orgPermissions(membership.role))) throw new Error("Forbidden")

  return { user: session.user, role: membership.role }
}

export interface MyOrg {
  id: string
  display_name: string
  legal_name: string | null
  kind: string
  status: string
  myRole: org_role
  domains: {
    id: string
    domain: string
    verified: boolean
    method: string
    token: string
    /**
     * Computed here, not in the browser. `roleAddressesFor` lives in
     * `lib/domain-verify.ts`, which imports `dns/promises` — importing it from
     * a client component pulls a Node module into the bundle and fails the
     * build. The addresses are a property of the domain, so the server that
     * already knows the domain is the right place to derive them.
     */
    roleAddresses: string[]
  }[]
}

/**
 * Organisations the signed-in user belongs to.
 *
 * Returns a list, not one org: an agency running events for several clients is
 * a real shape, and a screen that assumes one org would silently show them the
 * first alphabetically.
 */
export async function getMyOrgs(): Promise<MyOrg[]> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const memberships = await db.organisation_members.findMany({
    where: { user_id: session.user.id },
    select: {
      role: true,
      org: {
        select: {
          id: true,
          display_name: true,
          legal_name: true,
          kind: true,
          status: true,
          domains: {
            select: { id: true, domain: true, verified_at: true, method: true, verification_token: true },
          },
        },
      },
    },
    orderBy: { created_at: "asc" },
  })

  return memberships.map((m) => ({
    id: m.org.id,
    display_name: m.org.display_name,
    legal_name: m.org.legal_name,
    kind: m.org.kind,
    status: m.org.status,
    myRole: m.role,
    domains: m.org.domains.map((d) => ({
      id: d.id,
      domain: d.domain,
      verified: !!d.verified_at,
      method: d.method,
      roleAddresses: roleAddressesFor(d.domain),
      token: d.verification_token,
    })),
  }))
}

export interface OrgMemberRow {
  id: string
  userId: string
  name: string | null
  email: string
  role: org_role
  isPrimary: boolean
  joinedAt: Date
}

export interface OrgInviteRow {
  id: string
  email: string
  role: org_role
  expiresAt: Date
  createdAt: Date
  overrideReason: string | null
}

export interface OrgJoinRequestRow {
  id: string
  userId: string
  name: string | null
  email: string
  createdAt: Date
}

export async function getOrgMembers(orgId: string): Promise<{
  members: OrgMemberRow[]
  invites: OrgInviteRow[]
  joinRequests: OrgJoinRequestRow[]
}> {
  // Reading the member list needs membership, not management — staff should be
  // able to see who their colleagues are.
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")
  const mine = await db.organisation_members.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: session.user.id } },
    select: { role: true },
  })
  if (!mine) throw new Error("Forbidden")

  const canManage = orgPermissions(mine.role).canManageMembers

  const [members, invites, joinRequests] = await Promise.all([
    db.organisation_members.findMany({
      where: { org_id: orgId },
      select: {
        id: true,
        user_id: true,
        role: true,
        is_primary_contact: true,
        created_at: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: [{ is_primary_contact: "desc" }, { created_at: "asc" }],
    }),
    // Pending invites and join requests are management surface — staff see the
    // roster, not who is halfway through being added.
    canManage
      ? db.organisation_invites.findMany({
          where: { org_id: orgId, accepted_at: null, revoked_at: null, expires_at: { gt: new Date() } },
          orderBy: { created_at: "desc" },
        })
      : Promise.resolve([]),
    canManage
      ? db.organisation_join_requests.findMany({
          where: { org_id: orgId, status: "pending" },
          select: { id: true, user_id: true, created_at: true, user: { select: { name: true, email: true } } },
          orderBy: { created_at: "asc" },
        })
      : Promise.resolve([]),
  ])

  return {
    members: members.map((m) => ({
      id: m.id,
      userId: m.user_id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      isPrimary: m.is_primary_contact,
      joinedAt: m.created_at,
    })),
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expires_at,
      createdAt: i.created_at,
      overrideReason: i.domain_override_reason,
    })),
    joinRequests: joinRequests.map((j) => ({
      id: j.id,
      userId: j.user_id,
      name: j.user.name,
      email: j.user.email,
      createdAt: j.created_at,
    })),
  }
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** What the invitee is told they are being invited as. */
const ROLE_LABELS: Record<org_role, string> = {
  owner: "an owner",
  admin: "an admin",
  staff: "staff",
}

export interface InviteResult {
  ok: boolean
  /** Set when the address is outside a verified domain and no reason was given. */
  needsReason?: boolean
  message: string
  /** Only when email is unconfigured — the link to pass on by hand. */
  link?: string
}

/**
 * Invite someone to an organisation.
 *
 * The honest limit, once: this does not stop an owner inviting whoever they
 * like — that is their company's call, as it is in Slack or Notion. What it
 * enforces is that inviting outside the verified domain is deliberate,
 * reasoned, and in the audit log.
 *
 * An owner cannot be invited. Ownership transfers by an existing owner
 * promoting someone, so an invite that mints an owner would let an admin
 * escalate past their own ceiling by emailing themselves.
 */
export async function inviteMember(
  orgId: string,
  email: string,
  role: org_role,
  reason?: string
): Promise<InviteResult> {
  const { user, role: myRole } = await requireOrgRole(orgId, (p) => p.canManageMembers)

  if (role === "owner" && myRole !== "owner") {
    throw new Error("Only an owner can invite another owner.")
  }

  const target = email.trim().toLowerCase()
  if (!emailDomain(target)) return { ok: false, message: "That doesn't look like an email address." }

  const org = await db.organisations.findUniqueOrThrow({
    where: { id: orgId },
    select: {
      display_name: true,
      domains: { where: { verified_at: { not: null } }, select: { domain: true } },
    },
  })

  const policy = invitePolicy({
    verifiedDomains: org.domains.map((d) => d.domain),
    email: target,
    reason,
  })
  if (!policy.ok) {
    return { ok: false, needsReason: true, message: policy.message ?? "A reason is required." }
  }

  const already = await db.organisation_members.findFirst({
    where: { org_id: orgId, user: { email: target } },
    select: { id: true },
  })
  if (already) return { ok: false, message: "They're already a member." }

  const outstanding = await db.organisation_invites.findFirst({
    where: {
      org_id: orgId,
      email: target,
      accepted_at: null,
      revoked_at: null,
      expires_at: { gt: new Date() },
    },
    select: { id: true },
  })
  if (outstanding) return { ok: false, message: "They already have an invite outstanding." }

  const token = newInviteToken()
  const invite = await db.organisation_invites.create({
    data: {
      org_id: orgId,
      email: target,
      role,
      token_hash: hashInviteToken(token),
      expires_at: new Date(Date.now() + INVITE_TTL_MS),
      invited_by: user.id,
      domain_override_reason: policy.requiresReason ? (reason ?? "").trim() : null,
    },
    select: { id: true },
  })

  const link = `${appUrl()}/invite?token=${encodeURIComponent(token)}`
  let sent = false
  if (emailConfigured()) {
    const result = await sendEmail({
      to: target,
      ...inviteEmail(org.display_name, user.name ?? "A colleague", link, ROLE_LABELS[role]),
    })
    sent = result.sent
    if (!result.sent) logger.error("Invite email failed", { inviteId: invite.id, reason: result.reason })
  }

  auditLog({
    userId: user.id,
    action: policy.requiresReason ? "org.invite.domain_override" : "org.invite",
    resource: "organisation",
    resourceId: orgId,
    details: {
      inviteId: invite.id,
      email: target,
      role,
      reason: policy.requiresReason ? (reason ?? "").trim() : null,
      emailSent: sent,
    },
  })

  revalidatePath("/dashboard/organisation")

  return {
    ok: true,
    message: sent ? `Invite sent to ${target}.` : `Invite created. Email isn't configured — send them this link.`,
    // Returned only when nothing was emailed, so there is no other way to
    // deliver it. Once the mail goes out, the token stays in the mailbox.
    ...(sent ? {} : { link }),
  }
}

export async function revokeInvite(orgId: string, inviteId: string): Promise<void> {
  const { user } = await requireOrgRole(orgId, (p) => p.canManageMembers)

  await db.organisation_invites.updateMany({
    // org_id in the filter: an invite id from another org must not be revocable
    // by guessing it.
    where: { id: inviteId, org_id: orgId, accepted_at: null },
    data: { revoked_at: new Date() },
  })

  auditLog({
    userId: user.id,
    action: "org.invite.revoked",
    resource: "organisation",
    resourceId: orgId,
    details: { inviteId },
  })
  revalidatePath("/dashboard/organisation")
}

export async function setMemberRole(orgId: string, memberId: string, role: org_role): Promise<void> {
  const { user, role: myRole } = await requireOrgRole(orgId, (p) => p.canManageMembers)

  const member = await db.organisation_members.findFirst({
    where: { id: memberId, org_id: orgId },
    select: { id: true, role: true, user_id: true },
  })
  if (!member) throw new Error("Not a member of this organisation")

  // An admin cannot make owners, nor demote one. Otherwise the admin tier is
  // the owner tier with an extra click.
  if (myRole !== "owner" && (role === "owner" || member.role === "owner")) {
    throw new Error("Only an owner can change an owner's role.")
  }

  // Losing the last owner leaves an org nobody can administer — including the
  // person who just did it.
  if (member.role === "owner" && role !== "owner") {
    const owners = await db.organisation_members.count({ where: { org_id: orgId, role: "owner" } })
    if (owners <= 1) throw new Error("Promote another owner first — an organisation needs one.")
  }

  await db.organisation_members.update({ where: { id: memberId }, data: { role } })

  auditLog({
    userId: user.id,
    action: "org.member.role_changed",
    resource: "organisation",
    resourceId: orgId,
    details: { memberId, userId: member.user_id, from: member.role, to: role },
  })
  revalidatePath("/dashboard/organisation")
}

export async function removeMember(orgId: string, memberId: string): Promise<void> {
  const { user, role: myRole } = await requireOrgRole(orgId, (p) => p.canManageMembers)

  const member = await db.organisation_members.findFirst({
    where: { id: memberId, org_id: orgId },
    select: { role: true, user_id: true },
  })
  if (!member) throw new Error("Not a member of this organisation")

  if (member.role === "owner") {
    if (myRole !== "owner") throw new Error("Only an owner can remove an owner.")
    const owners = await db.organisation_members.count({ where: { org_id: orgId, role: "owner" } })
    if (owners <= 1) throw new Error("This is the last owner. Promote someone else first.")
  }

  await db.organisation_members.delete({ where: { id: memberId } })

  auditLog({
    userId: user.id,
    action: "org.member.removed",
    resource: "organisation",
    resourceId: orgId,
    details: { userId: member.user_id, role: member.role },
  })
  revalidatePath("/dashboard/organisation")
}

/* -------------------------------------------------------------------------- */
/* Domains                                                                     */
/* -------------------------------------------------------------------------- */

export interface DomainClaimResult {
  ok: boolean
  message: string
  instructions?: ReturnType<typeof txtInstructions>
  roleAddresses?: string[]
}

/** A link in an inbox for ever is a way in for whoever inherits it. */
const DOMAIN_EMAIL_TTL_MS = 24 * 60 * 60 * 1000

export async function claimDomain(orgId: string, raw: string): Promise<DomainClaimResult> {
  const { user } = await requireOrgRole(orgId, (p) => p.canVerifyDomain)

  const domain = normaliseDomain(raw)
  if (!domain) return { ok: false, message: "That doesn't look like a domain." }
  if (isFreeProvider(domain)) {
    return { ok: false, message: "You can't claim a public email provider — use your own domain." }
  }

  const existing = await db.organisation_domains.findUnique({
    where: { domain },
    select: { org_id: true, verified_at: true, verification_token: true },
  })
  if (existing && existing.org_id !== orgId) {
    // Deliberately vague. Confirming which org holds a domain would let anyone
    // enumerate the customer list one domain at a time.
    return { ok: false, message: "That domain is already claimed. Contact support if it's yours." }
  }
  if (existing) {
    return {
      ok: true,
      message: existing.verified_at ? "Already verified." : "Claim already open — add the record below.",
      instructions: txtInstructions(domain, existing.verification_token),
      roleAddresses: roleAddressesFor(domain),
    }
  }

  const token = newDomainToken()
  await db.organisation_domains.create({
    data: { org_id: orgId, domain, method: "dns_txt", verification_token: token },
  })

  auditLog({
    userId: user.id,
    action: "org.domain.claimed",
    resource: "organisation",
    resourceId: orgId,
    details: { domain },
  })
  revalidatePath("/dashboard/organisation")

  return {
    ok: true,
    message: "Add this TXT record, then check again.",
    instructions: txtInstructions(domain, token),
    roleAddresses: roleAddressesFor(domain),
  }
}

export async function verifyDomain(orgId: string, domainId: string): Promise<{ ok: boolean; message: string }> {
  const { user } = await requireOrgRole(orgId, (p) => p.canVerifyDomain)

  const row = await db.organisation_domains.findFirst({
    where: { id: domainId, org_id: orgId },
  })
  if (!row) throw new Error("Domain not found")
  if (row.verified_at) return { ok: true, message: "Already verified." }

  const check = await checkDomainTxt(row.domain, row.verification_token)
  if (!check.verified) {
    // The claim is left in place on failure — DNS takes time to propagate, and
    // deleting it would make the person start over for being early.
    return {
      ok: false,
      message:
        check.reason === "no_records"
          ? "No TXT records found yet. DNS can take up to an hour to propagate."
          : check.reason === "not_found"
            ? "Found TXT records, but not ours. Check the value is exact."
            : "Couldn't look up that domain just now. Try again shortly.",
    }
  }

  await db.organisation_domains.update({
    where: { id: domainId },
    data: { verified_at: new Date(), verified_by: user.id },
  })

  auditLog({
    userId: user.id,
    action: "org.domain.verified",
    resource: "organisation",
    resourceId: orgId,
    details: { domain: row.domain, method: "dns_txt" },
  })
  revalidatePath("/dashboard/organisation")

  return { ok: true, message: `${row.domain} verified. Invites are now restricted to it by default.` }
}

/**
 * Verify a domain by emailing one of its role addresses.
 *
 * ## The path that did not exist
 *
 * `claimDomain` hardcodes `dns_txt`, and until now that was the only route.
 * `isRoleAddressFor` and `domainVerifyEmail` were written, tested and called by
 * nothing; the only writer of `email_role` was the onboarding approval, which
 * set it with an empty token and an immediate `verified_at` — a method recorded
 * for a check that never ran.
 *
 * So an organisation whose claimant is not the DNS administrator had **no route
 * to a verified domain**, and that is the ordinary case: the person setting up
 * the account is rarely the person with access to the zone file. A verified
 * domain is what gates auto-approval on event claims, so the gap was a funnel
 * blocker, not a nicety.
 *
 * ## Only a role address
 *
 * `postmaster@`, `admin@` and their siblings are addresses an individual
 * employee does not get to own — that is the whole basis of this proof. Sending
 * to `sagar@acme.com` would verify that Sagar works at Acme, which is not the
 * same claim, and is the claim an attacker with any mailbox at a large company
 * would like to make.
 *
 * ## What it does not reveal
 *
 * The same answer whether or not the mailbox exists. Telling a caller that
 * `security@` bounced and `admin@` did not is an enumeration oracle over
 * somebody else's mail setup.
 */
export async function sendDomainVerifyEmail(
  orgId: string,
  domainId: string,
  address: string
): Promise<{ ok: boolean; message: string }> {
  const { user } = await requireOrgRole(orgId, (p) => p.canVerifyDomain)

  const row = await db.organisation_domains.findFirst({
    where: { id: domainId, org_id: orgId },
    select: { id: true, domain: true, verified_at: true },
  })
  if (!row) throw new Error("Domain not found")
  if (row.verified_at) return { ok: true, message: "Already verified." }

  if (!isRoleAddressFor(address, row.domain)) {
    return {
      ok: false,
      message: `Pick one of the role addresses at ${row.domain} — a personal address proves the wrong thing.`,
    }
  }

  if (!emailConfigured()) {
    return { ok: false, message: "Email is not configured. Use the DNS record instead." }
  }

  /*
   * A fresh secret, never the TXT value.
   *
   * `organisation_domains.verification_token` is published in DNS and kept
   * after verification for re-checks. An emailed link built from it would be
   * verifiable by anybody who can read the record.
   */
  const token = newDomainToken()
  await db.domain_email_tokens.create({
    data: {
      token_hash: hashInviteToken(token),
      domain_id: row.id,
      sent_to: address.trim().toLowerCase(),
      expires_at: new Date(Date.now() + DOMAIN_EMAIL_TTL_MS),
    },
  })

  const link = `${process.env.NEXTAUTH_URL ?? ""}/verify-domain?token=${token}`
  const result = await sendEmail({ to: address, ...domainVerifyEmail(row.domain, link) })
  if (!result.sent) {
    logger.error("Domain verify email failed", { domainId, reason: result.reason })
    return { ok: false, message: "Could not send just now. Try again, or use the DNS record." }
  }

  auditLog({
    userId: user.id,
    action: "org.domain.email_sent",
    resource: "organisation",
    resourceId: orgId,
    details: { domain: row.domain, sentTo: address.trim().toLowerCase() },
  })

  return { ok: true, message: `Sent to ${address}. The link expires in 24 hours.` }
}

export async function removeDomain(orgId: string, domainId: string): Promise<void> {
  const { user } = await requireOrgRole(orgId, (p) => p.canVerifyDomain)
  const row = await db.organisation_domains.findFirst({
    where: { id: domainId, org_id: orgId },
    select: { domain: true },
  })
  if (!row) return

  await db.organisation_domains.deleteMany({ where: { id: domainId, org_id: orgId } })

  auditLog({
    userId: user.id,
    action: "org.domain.removed",
    resource: "organisation",
    resourceId: orgId,
    details: { domain: row.domain },
  })
  revalidatePath("/dashboard/organisation")
}

/* -------------------------------------------------------------------------- */
/* Join requests                                                               */
/* -------------------------------------------------------------------------- */

export async function decideJoinRequest(
  orgId: string,
  requestId: string,
  approve: boolean
): Promise<void> {
  const { user } = await requireOrgRole(orgId, (p) => p.canManageMembers)

  const request = await db.organisation_join_requests.findFirst({
    where: { id: requestId, org_id: orgId, status: "pending" },
    select: { id: true, user_id: true },
  })
  if (!request) throw new Error("Request not found")

  await db.$transaction(async (tx) => {
    await tx.organisation_join_requests.update({
      where: { id: request.id },
      data: { status: approve ? "approved" : "declined", decided_by: user.id, decided_at: new Date() },
    })
    if (approve) {
      // Always `staff`. A request-to-join is the weakest signal there is —
      // someone with an address on the domain — and granting anything more
      // from it would make domain verification an escalation path.
      await tx.organisation_members.create({
        data: { org_id: orgId, user_id: request.user_id, role: "staff" },
      })
    }
  })

  auditLog({
    userId: user.id,
    action: approve ? "org.join_request.approved" : "org.join_request.declined",
    resource: "organisation",
    resourceId: orgId,
    details: { userId: request.user_id },
  })
  revalidatePath("/dashboard/organisation")
}
