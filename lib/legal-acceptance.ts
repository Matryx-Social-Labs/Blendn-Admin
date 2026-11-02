import { isIP } from "node:net"

import { isUuid } from "./api-input"
import { auditInTx } from "./audit-log"
import { db } from "./db"
import { ticketingOn } from "./env"
import { activeMembership } from "./org-membership"

/**
 * Clickwrap acceptances of the legal documents an organisation agrees to
 * (SCRUM-1008; organizer-ticketing-terms-draft.md, "How acceptance works").
 *
 * The record is `legal_acceptances`, append-only by trigger: a new version
 * is a new row, and the newest row per organisation and document is the one
 * in force. Accepting binds the organisation, so only its owners and admins
 * may (the same line as billing and venue listing), and only the version in
 * force can be accepted: a stale tab is refused rather than recorded as
 * agreeing to text nobody is showing any more.
 */

export const ORGANIZER_TICKETING_TERMS = { key: "organizer-ticketing-terms", version: "0.1" } as const

/** Every document that can be accepted, and its version in force. */
const CURRENT_VERSION: Readonly<Record<string, string>> = {
  [ORGANIZER_TICKETING_TERMS.key]: ORGANIZER_TICKETING_TERMS.version,
}

const USER_AGENT_MAX = 512

export type AcceptanceRefusal = "ticketing_off" | "unknown_document" | "stale_version" | "not_authorized"

export interface AcceptanceInput {
  orgId: string
  userId: string
  documentKey: string
  version: string
  /** The client's address (`getRequestIp`). Anything that is not an IP is stored as nothing. */
  ip?: string | null
  userAgent?: string | null
  now?: Date
}

export interface LegalAcceptance {
  id: string
  userId: string
  version: string
  acceptedAt: Date
}

export type AcceptanceResult = { ok: true; acceptance: LegalAcceptance } | { ok: false; reason: AcceptanceRefusal }

const cleanIp = (ip: string | null | undefined): string | null => (ip && isIP(ip.trim()) ? ip.trim() : null)
const cleanUserAgent = (ua: string | null | undefined): string | null => (ua ? ua.slice(0, USER_AGENT_MAX) : null)

/**
 * Record that `userId` accepted a document for `orgId`, with an audit row in
 * the same transaction. The only document today is the ticketing terms, so
 * nothing is recorded while `TICKETING` is off.
 */
export async function recordLegalAcceptance(input: AcceptanceInput): Promise<AcceptanceResult> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  const current = Object.hasOwn(CURRENT_VERSION, input.documentKey) ? CURRENT_VERSION[input.documentKey] : undefined
  if (!current) return { ok: false, reason: "unknown_document" }
  if (input.version !== current) return { ok: false, reason: "stale_version" }
  if (!isUuid(input.orgId)) return { ok: false, reason: "not_authorized" }

  return db.$transaction(async (tx) => {
    const binding = await tx.organisation_members.findFirst({
      where: { org_id: input.orgId, user_id: input.userId, role: { in: ["owner", "admin"] }, ...activeMembership },
      select: { id: true },
    })
    if (!binding) return { ok: false as const, reason: "not_authorized" as const }

    const ip = cleanIp(input.ip)
    const row = await tx.legal_acceptances.create({
      data: {
        org_id: input.orgId,
        user_id: input.userId,
        document_key: input.documentKey,
        version: current,
        ip: ip,
        user_agent: cleanUserAgent(input.userAgent),
        ...(input.now && { accepted_at: input.now }),
      },
      select: { id: true, user_id: true, version: true, accepted_at: true },
    })
    await auditInTx(tx, {
      userId: input.userId,
      action: "legal.accept",
      resource: "organisation",
      resourceId: input.orgId,
      orgId: input.orgId,
      details: { documentKey: input.documentKey, version: current, acceptanceId: row.id },
      ...(ip && { ipAddress: ip }),
    })
    return { ok: true as const, acceptance: { id: row.id, userId: row.user_id, version: row.version, acceptedAt: row.accepted_at } }
  })
}

/** The acceptance in force for an organisation and document: the newest, or null if it never accepted. */
export async function latestLegalAcceptance(orgId: string, documentKey: string): Promise<LegalAcceptance | null> {
  if (!isUuid(orgId)) return null
  const row = await db.legal_acceptances.findFirst({
    where: { org_id: orgId, document_key: documentKey },
    orderBy: [{ accepted_at: "desc" }, { id: "desc" }],
    select: { id: true, user_id: true, version: true, accepted_at: true },
  })
  return row ? { id: row.id, userId: row.user_id, version: row.version, acceptedAt: row.accepted_at } : null
}
