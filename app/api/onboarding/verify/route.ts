import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { hashInviteToken } from "@/lib/org-invites"
import { auditLog, getRequestIp } from "@/lib/audit-log"

/**
 * Confirm an applicant's email address.
 *
 * The token is looked up by hash, so a leaked database yields nothing usable.
 * It is single-use and expires in 24 hours — a link sitting in an inbox
 * forever is a way in for whoever inherits the mailbox.
 *
 * All this proves is that the applicant can receive mail at the address they
 * gave. That is worth having (it is what makes the company-domain tier mean
 * anything) and it is not approval — a human still reviews every application.
 */

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, {
    windowMs: 15 * 60 * 1000,
    maxRequests: 20,
    keyGenerator: (r) =>
      `onboarding:verify:${r.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"}`,
  })
  if (limited) return limited

  try {
    const { token } = (await req.json()) as { token?: string }
    if (!token) {
      return NextResponse.json({ success: false, error: "Missing token." }, { status: 400 })
    }

    const row = await db.onboarding_email_tokens.findUnique({
      where: { token_hash: hashInviteToken(token) },
    })

    // One message for every failure. Distinguishing "no such token" from
    // "expired" tells someone probing which of their guesses were once real.
    const invalid = NextResponse.json(
      { success: false, error: "This link is invalid or has expired. Apply again to get a new one." },
      { status: 400 }
    )
    if (!row) return invalid

    const request = await db.organiser_onboarding_requests.findUnique({
      where: { id: row.request_id },
      select: { id: true, status: true, display_name: true, email_verified_at: true },
    })
    if (!request) return invalid

    /*
     * Already confirmed is a SUCCESS, and this check has to come before the
     * spent-token check or it never runs.
     *
     * People click the link twice — they re-open the mail, or their client
     * prefetches it. The first version rejected the second click with "invalid
     * or expired, apply again", which sent someone to re-submit an application
     * that was already sitting in the queue, where the duplicate guard then
     * refused them outright. A dead end reached by doing nothing wrong.
     *
     * Found by clicking twice against staging, not by reading the code.
     */
    if (request.email_verified_at) {
      return NextResponse.json({
        success: true,
        alreadyVerified: true,
        displayName: request.display_name,
      })
    }

    // Spent or expired without ever confirming: genuinely no longer usable.
    if (row.used_at || row.expires_at.getTime() <= Date.now()) return invalid
    if (request.status !== "email_pending") return invalid

    await db.$transaction([
      db.onboarding_email_tokens.update({
        where: { token_hash: row.token_hash },
        data: { used_at: new Date() },
      }),
      db.organiser_onboarding_requests.update({
        where: { id: request.id },
        data: { email_verified_at: new Date(), status: "pending" },
      }),
    ])

    auditLog({
      action: "onboarding.email_verified",
      resource: "organiser_onboarding_request",
      resourceId: request.id,
      ipAddress: getRequestIp(req),
    })

    return NextResponse.json({ success: true, displayName: request.display_name })
  } catch (err) {
    logger.error("Onboarding verify failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ success: false, error: "Something went wrong." }, { status: 500 })
  }
}
