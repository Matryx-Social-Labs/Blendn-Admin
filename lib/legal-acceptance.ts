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
 *
 * What is kept is what proves the click and no more (security M1, M2, L1, L2;
 * database 11, 12): the network the click came from, never the address (/24
 * for IPv4, /48 for IPv6, in this row and its audit row alike), a user agent
 * of at most 200 characters, and `document_sha256`, the hash of the exact text
 * shown, so "version 0.1" can be proved to mean those words. A suspended
 * person or a suspended organisation binds nobody.
 *
 * Revoking UPDATE and DELETE on this table from the app's database role is
 * infrastructure (the triggers are the floor until then), noted on SCRUM-1010.
 */

export const ORGANIZER_TICKETING_TERMS = { key: "organizer-ticketing-terms", version: "0.1" } as const

/** Every document that can be accepted, and its version in force. */
const CURRENT_VERSION: Readonly<Record<string, string>> = {
  [ORGANIZER_TICKETING_TERMS.key]: ORGANIZER_TICKETING_TERMS.version,
}

/** Code points, as `char_length` counts them (CHECK `legal_acceptances_user_agent_length`). */
const USER_AGENT_MAX = 200
const SHA256_HEX = /^[0-9a-f]{64}$/

export type AcceptanceRefusal = "ticketing_off" | "unknown_document" | "stale_version" | "bad_document_hash" | "not_authorized"

export interface AcceptanceInput {
  orgId: string
  userId: string
  documentKey: string
  version: string
  /**
   * sha256, hex, of the exact text the server rendered for this version. The
   * server computes it from what it served, never the browser's word.
   */
  documentSha256: string
  /** The client's address (`getRequestIp`). Stored as its network (`truncatedIp`); anything that is not an IP, as nothing. */
  ip?: string | null
  userAgent?: string | null
}

export interface LegalAcceptance {
  id: string
  userId: string
  version: string
  acceptedAt: Date
}

export type AcceptanceResult = { ok: true; acceptance: LegalAcceptance } | { ok: false; reason: AcceptanceRefusal }

/** An IPv6 address as its eight groups, `::` and a dotted IPv4 tail expanded. */
function ipv6Groups(ip: string): number[] {
  const dotted = ip.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  const hex = dotted ? `${ip.slice(0, dotted.index)}${((+dotted[1] << 8) | +dotted[2]).toString(16)}:${((+dotted[3] << 8) | +dotted[4]).toString(16)}` : ip
  const [head, tail] = hex.split("::")
  const left = head ? head.split(":") : []
  const right = tail === undefined ? [] : tail ? tail.split(":") : []
  const middle = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0")
  return [...left, ...middle, ...right].map((g) => parseInt(g, 16))
}

/**
 * The network an address is in, never the address: `203.0.113.0/24`,
 * `2001:db8:85a3::/48`. An IPv4-mapped IPv6 address is the IPv4 it maps.
 * Anything that is not an IP is null. CHECK `legal_acceptances_ip_truncated`.
 */
export function truncatedIp(raw: string | null | undefined): string | null {
  const ip = raw?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "") ?? ""
  const family = isIP(ip)
  if (family === 4) return `${ip.split(".").slice(0, 3).join(".")}.0/24`
  if (family !== 6) return null
  return `${ipv6Groups(ip.replace(/%.*$/, "")).slice(0, 3).map((g) => g.toString(16)).join(":")}::/48`
}

/** By code points, so an emoji is never cut in half into a lone surrogate. */
const cleanUserAgent = (ua: string | null | undefined): string | null => (ua ? Array.from(ua).slice(0, USER_AGENT_MAX).join("") : null)

/**
 * Record that `userId` accepted a document for `orgId`, with an audit row in
 * the same transaction. The only document today is the ticketing terms, so
 * nothing is recorded while `TICKETING` is off. The time is the database's.
 */
export async function recordLegalAcceptance(input: AcceptanceInput): Promise<AcceptanceResult> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  const current = Object.hasOwn(CURRENT_VERSION, input.documentKey) ? CURRENT_VERSION[input.documentKey] : undefined
  if (!current) return { ok: false, reason: "unknown_document" }
  if (input.version !== current) return { ok: false, reason: "stale_version" }
  if (typeof input.documentSha256 !== "string" || !SHA256_HEX.test(input.documentSha256)) return { ok: false, reason: "bad_document_hash" }
  if (!isUuid(input.orgId)) return { ok: false, reason: "not_authorized" }

  return db.$transaction(async (tx) => {
    // A suspended organisation (activeMembership) or a suspended or deleted person binds nobody.
    const binding = await tx.organisation_members.findFirst({
      where: {
        org_id: input.orgId,
        user_id: input.userId,
        role: { in: ["owner", "admin"] },
        ...activeMembership,
        user: { suspended_at: null, deletedAt: null },
      },
      select: { id: true },
    })
    if (!binding) return { ok: false as const, reason: "not_authorized" as const }

    const ip = truncatedIp(input.ip)
    const row = await tx.legal_acceptances.create({
      data: {
        org_id: input.orgId,
        user_id: input.userId,
        document_key: input.documentKey,
        version: current,
        ip: ip,
        user_agent: cleanUserAgent(input.userAgent),
        document_sha256: input.documentSha256,
      },
      select: { id: true, user_id: true, version: true, accepted_at: true },
    })
    await auditInTx(tx, {
      userId: input.userId,
      action: "legal.accept",
      resource: "organisation",
      resourceId: input.orgId,
      orgId: input.orgId,
      details: { documentKey: input.documentKey, version: current, documentSha256: input.documentSha256, acceptanceId: row.id },
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
