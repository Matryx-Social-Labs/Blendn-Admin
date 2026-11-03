import type { user_role } from "@prisma/client"

import { isUuid } from "./api-input"
import { auditInTx } from "./audit-log"
import { db } from "./db"
import { razorpayKeys, ticketingOn } from "./env"
import { logger } from "./logger"
import { activeMembership, actorFor } from "./org-membership"
import { linkedAccountStatus } from "./razorpay"

/**
 * The payout account's two writers (SCRUM-1014), v1 of "Connect payouts".
 *
 * Hosted KYC onboarding (Razorpay creating and verifying the linked account
 * from our dashboard) is out of scope: the organization does that with
 * Razorpay, and then
 *
 * 1. an owner or admin of the organization enters the linked account id
 *    (`acc_` + 14), which waits as `pending`;
 * 2. a Blend'n admin asks Razorpay, and marks it `active` only when Razorpay
 *    says `activated` (or `rejected`). Only `active` sells (`payoutStatus`,
 *    `enableTicketing`).
 *
 * Every change is audit-logged on the organization. An active account is not
 * replaced from the dashboard: payouts on hold are transferred to it.
 */

const ACCOUNT_ID = /^acc_[A-Za-z0-9]{14}$/
const ACTIVATED = "activated"
type User = { id: string; role: user_role }

export type SubmitRefusal = "ticketing_off" | "not_found" | "not_authorized" | "invalid" | "already_active"
export type ReviewRefusal = "ticketing_off" | "not_found" | "not_authorized" | "no_account" | "razorpay_disagrees" | "razorpay_unreachable"

/** The organization's owners and admins (live memberships) may bind it, as for the terms and billing. */
async function bindsOrg(userId: string, orgId: string): Promise<boolean> {
  const row = await db.organisation_members.findFirst({
    where: { org_id: orgId, user_id: userId, role: { in: ["owner", "admin"] }, ...activeMembership, user: { suspended_at: null, deletedAt: null } },
    select: { id: true },
  })
  return row !== null
}

/** An owner or admin of the event's organization enters its Razorpay linked account id. */
export async function submitPayoutAccount(eventId: string, user: User, accountId: string): Promise<{ ok: true } | { ok: false; reason: SubmitRefusal }> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!isUuid(eventId)) return { ok: false, reason: "not_found" }
  const id = typeof accountId === "string" ? accountId.trim() : ""
  const event = await db.events.findFirst({ where: { id: eventId, deleted_at: null }, select: { organizer_org_id: true } })
  const orgId = event?.organizer_org_id
  if (!orgId) return { ok: false, reason: "not_found" }
  const actor = await actorFor(user)
  if (actor.role !== "app_admin" && !(await bindsOrg(user.id, orgId))) return { ok: false, reason: "not_authorized" }
  if (!ACCOUNT_ID.test(id)) return { ok: false, reason: "invalid" }

  return db.$transaction(async (tx) => {
    const [org] = await tx.$queryRaw<{ razorpay_account_status: string; razorpay_account_id: string | null }[]>`
      SELECT razorpay_account_status::text AS razorpay_account_status, razorpay_account_id FROM organisations WHERE id = ${orgId}::uuid FOR UPDATE`
    if (!org) return { ok: false as const, reason: "not_found" as const }
    if (org.razorpay_account_status === "active") return { ok: false as const, reason: "already_active" as const }
    await tx.organisations.update({ where: { id: orgId }, data: { razorpay_account_id: id, razorpay_account_status: "pending" } })
    await auditInTx(tx, {
      userId: user.id,
      action: "payouts.account_submitted",
      resource: "organisation",
      resourceId: orgId,
      orgId,
      details: { accountId: id, from: org.razorpay_account_status, previousAccountId: org.razorpay_account_id },
    })
    return { ok: true as const }
  })
}

/**
 * A Blend'n admin marks an organization's payout account active or rejected.
 * Active only on Razorpay's word: with Razorpay configured, the account must
 * read `activated` there. Without keys (a local database) nothing can be
 * paid anyway; the row records that Razorpay was not asked.
 */
export async function reviewPayoutAccount(
  orgId: string,
  user: User,
  decision: "active" | "rejected"
): Promise<{ ok: true } | { ok: false; reason: ReviewRefusal; razorpay?: string }> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!isUuid(orgId) || (decision !== "active" && decision !== "rejected")) return { ok: false, reason: "not_found" }
  if ((await actorFor(user)).role !== "app_admin") return { ok: false, reason: "not_authorized" }
  const org = await db.organisations.findUnique({ where: { id: orgId }, select: { razorpay_account_id: true } })
  if (!org) return { ok: false, reason: "not_found" }
  const accountId = org.razorpay_account_id
  if (!accountId) return { ok: false, reason: "no_account" }

  let razorpay = "not_checked"
  if (decision === "active" && razorpayKeys()) {
    try {
      razorpay = await linkedAccountStatus(accountId)
    } catch (error) {
      logger.error("Razorpay linked account read failed", { orgId, error: error instanceof Error ? error.message : String(error) })
      return { ok: false, reason: "razorpay_unreachable" }
    }
    if (razorpay !== ACTIVATED) return { ok: false, reason: "razorpay_disagrees", razorpay }
  }

  return db.$transaction(async (tx) => {
    // The account the decision is about, still: a resubmission in between is not what Razorpay was asked about.
    const [now] = await tx.$queryRaw<{ razorpay_account_id: string | null; razorpay_account_status: string }[]>`
      SELECT razorpay_account_id, razorpay_account_status::text AS razorpay_account_status FROM organisations WHERE id = ${orgId}::uuid FOR UPDATE`
    if (!now || now.razorpay_account_id !== accountId) return { ok: false as const, reason: "no_account" as const }
    await tx.organisations.update({ where: { id: orgId }, data: { razorpay_account_status: decision } })
    await auditInTx(tx, {
      userId: user.id,
      action: "payouts.account_reviewed",
      resource: "organisation",
      resourceId: orgId,
      orgId,
      details: { accountId, decision, from: now.razorpay_account_status, razorpay },
    })
    return { ok: true as const }
  })
}

/** When the account now waiting was entered, from its audit row: "Sent 1 Nov". */
export async function payoutSubmittedAt(orgId: string): Promise<Date | null> {
  const row = await db.audit_logs.findFirst({
    where: { org_id: orgId, action: "payouts.account_submitted" },
    orderBy: { created_at: "desc" },
    select: { created_at: true },
  })
  return row?.created_at ?? null
}
