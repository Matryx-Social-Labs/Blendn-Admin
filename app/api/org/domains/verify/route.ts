import { NextRequest, NextResponse } from "next/server"

import { auditLog, getRequestIp } from "@/lib/audit-log"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { hashInviteToken } from "@/lib/org-invites"
import { rateLimit } from "@/lib/rate-limit"

/**
 * Confirm a domain from the link sent to one of its role addresses.
 *
 * Unauthenticated by necessity: the person who reads `postmaster@acme.com` is
 * usually not the person who started the claim, and often has no account. What
 * the link proves is control of a mailbox nobody but the company can hold —
 * which is the whole basis of the proof, and why only role addresses are
 * accepted at the sending end.
 *
 * The token is looked up **by hash**, so a leaked database yields nothing
 * usable. It is single-use and expires in 24 hours: a link sitting in a shared
 * inbox for ever is a way in for whoever inherits the mailbox.
 *
 * It is deliberately NOT `organisation_domains.verification_token`. That value
 * is published in the domain's TXT record, so a link built from it would be
 * verifiable by anybody who can read DNS.
 */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, {
    windowMs: 15 * 60 * 1000,
    maxRequests: 20,
    keyGenerator: (r) =>
      `domain:verify:${r.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"}`,
  })
  if (limited) return limited

  try {
    const { token } = (await req.json()) as { token?: string }
    if (!token) {
      return NextResponse.json({ success: false, error: "Missing token." }, { status: 400 })
    }

    /*
     * One message for every failure. Distinguishing "no such token" from
     * "expired" from "already used" tells somebody probing which of their
     * guesses were once real.
     */
    const invalid = NextResponse.json(
      { success: false, error: "This link is invalid or has expired. Ask for a new one." },
      { status: 400 }
    )

    const row = await db.domain_email_tokens.findUnique({
      where: { token_hash: hashInviteToken(token) },
      select: {
        token_hash: true,
        sent_to: true,
        used_at: true,
        expires_at: true,
        domain: { select: { id: true, domain: true, org_id: true, verified_at: true } },
      },
    })
    if (!row) return invalid

    /*
     * Already verified is a SUCCESS, and this has to come before the spent
     * check or it never runs — somebody clicking the link twice, or forwarding
     * it to a colleague who also clicks, has not done anything wrong.
     */
    if (row.domain.verified_at) {
      return NextResponse.json({ success: true, domain: row.domain.domain })
    }
    if (row.used_at || row.expires_at < new Date()) return invalid

    /*
     * Spend the token and verify in one transaction, guarded on it still being
     * unspent. Two clicks arriving together otherwise both pass the read above
     * and both write — harmless here, but it would put two rows in the audit
     * log for one act, and the audit log is the thing that has to be true.
     */
    await db.$transaction(async (tx) => {
      const { count } = await tx.domain_email_tokens.updateMany({
        where: { token_hash: row.token_hash, used_at: null },
        data: { used_at: new Date() },
      })
      if (count === 0) return

      await tx.organisation_domains.update({
        where: { id: row.domain.id },
        data: {
          verified_at: new Date(),
          method: "email_role",
          /*
           * No `verified_by`: nobody was signed in, and naming the person who
           * started the claim would credit them with a proof they did not
           * perform. The mailbox is recorded in the audit entry instead.
           */
        },
      })
    })

    auditLog({
      // No signed-in actor: the mailbox is the proof, and it is in .
      userId: undefined,
      action: "org.domain.verified",
      resource: "organisation",
      resourceId: row.domain.org_id,
      details: { domain: row.domain.domain, method: "email_role", confirmedBy: row.sent_to },
      ipAddress: getRequestIp(req),
    })

    return NextResponse.json({ success: true, domain: row.domain.domain })
  } catch (error) {
    logger.error("Domain email verification failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { success: false, error: "Something went wrong. Try again." },
      { status: 500 }
    )
  }
}
