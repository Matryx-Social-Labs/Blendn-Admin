import { clientIpFrom } from "@/lib/client-ip"
import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import { hashInviteToken } from "@/lib/org-invites"
import { checkPassword } from "@/lib/password"
import { dashboardSessionsEnded, endPhoneSessions, phoneSessionsEnded } from "@/lib/session-end"
import { readJson } from "@/lib/api-input"
import { appLinksFor, audienceOf } from "@/lib/app-links"

/**
 * Consume a reset token and set a new password.
 *
 * The token is looked up by hash, single-use, and claimed inside the same
 * transaction that writes the password — so two concurrent submissions of the
 * same link cannot both succeed.
 *
 * Resetting also **revokes every mobile refresh token** for the account. If
 * someone is resetting because they were compromised, leaving the attacker's
 * mobile session alive would defeat the point.
 *
 * Dashboard sessions are NextAuth JWTs and are not stored, so they cannot be
 * revoked from here — an existing dashboard session survives until its own
 * expiry. Closing that properly means a `passwordChangedAt` check in the JWT
 * callback, which costs a database read on every request; it is worth doing when
 * there is a reason to, and is noted rather than pretended about.
 */

/**
 * The token's row if it can still reset a password, else null: unused,
 * unexpired, for an account that still exists. The reset and the page's check
 * both ask this, so the page cannot promise a link the reset then refuses.
 */
async function usableResetToken(token: string) {
  const row = await db.password_reset_tokens.findUnique({
    where: { token_hash: hashInviteToken(token) },
    select: {
      token_hash: true,
      used_at: true,
      expires_at: true,
      user: { select: { id: true, email: true, deletedAt: true, role: true } },
    },
  })
  if (!row || row.used_at || row.expires_at.getTime() <= Date.now() || row.user.deletedAt) return null
  return row
}

/**
 * Does this link still work? Asked by the page on load, so a used, expired or
 * tampered link says so before anyone types a password (SCRUM-461). Consumes
 * nothing, and answers every dead link the same way, as the reset does.
 * Its own limit, so opening the page never spends a reset attempt.
 */
export async function GET(req: NextRequest) {
  const limited = await rateLimit(req, {
    windowMs: 15 * 60 * 1000,
    maxRequests: 30,
    keyGenerator: (r) => `auth:reset-check:${clientIpFrom(r.headers)}`,
  })
  if (limited) return limited

  const token = req.nextUrl.searchParams.get("token")
  const row = token ? await usableResetToken(token) : null
  /*
   * `audience` rides a live link only (SV15): somebody holding the link is the
   * account's own owner, and a dead link still answers just `valid: false`. It
   * tells the page which "done" to draw — the phone app's, or the dashboard's.
   */
  return NextResponse.json({ valid: row !== null, ...(row && { audience: audienceOf(row.user.role) }) })
}

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, {
    windowMs: 15 * 60 * 1000,
    maxRequests: 10,
    keyGenerator: (r) =>
      `auth:reset:${clientIpFrom(r.headers)}`,
  })
  if (limited) return limited

  try {
    const { token, password } = ((await readJson(req)) ?? {}) as { token?: unknown; password?: unknown }

    // One message for every token failure. Distinguishing "no such token" from
    // "expired" tells someone probing which of their guesses were once real.
    const invalid = NextResponse.json(
      { error: "This reset link is invalid or has expired. Request a new one." },
      { status: 400 }
    )
    if (typeof token !== "string" || typeof password !== "string" || !token || !password) return invalid

    const row = await usableResetToken(token)
    if (!row) return invalid

    // Checked here as well as in the form — the form's copy of the rule is a
    // courtesy, this is the rule.
    const check = checkPassword(password, row.user.email)
    if (!check.ok) return NextResponse.json({ error: check.message }, { status: 400 })

    const hashed = await bcrypt.hash(password, 12)

    const at = new Date()
    let phonesEndedAt = at
    await db.$transaction(async (tx) => {
      // Claiming with `used_at: null` in the filter is the concurrency guard:
      // the second of two simultaneous submissions matches zero rows.
      const claimed = await tx.password_reset_tokens.updateMany({
        where: { token_hash: row.token_hash, used_at: null },
        data: { used_at: new Date() },
      })
      if (claimed.count === 0) throw new Error("ALREADY_USED")

      // And every dashboard session signed in before now (step 18 M6): the
      // JWT has no row to delete, so `isRevoked` (lib/session-revocation.ts)
      // ends it by this time, wherever it is read.
      await tx.user.update({ where: { id: row.user.id }, data: { password: hashed, password_changed_at: at } })

      // The point of resetting after a compromise: every phone too.
      phonesEndedAt = (await endPhoneSessions(tx, row.user.id, "password_reset")).at
    })
    // And what was live when it changed closes now (SCRUM-603).
    dashboardSessionsEnded(row.user.id)
    phoneSessionsEnded(row.user.id, phonesEndedAt)

    auditLog({
      userId: row.user.id,
      action: "auth.password_reset_completed",
      resource: "user",
      resourceId: row.user.id,
      ipAddress: getRequestIp(req),
    })

    // An attendee's account lives on the phone: say so, and where to open it (SV15).
    const audience = audienceOf(row.user.role)
    return NextResponse.json({ ok: true, audience, app: appLinksFor(audience) })
  } catch (err) {
    if (err instanceof Error && err.message === "ALREADY_USED") {
      return NextResponse.json(
        { error: "This reset link has already been used." },
        { status: 400 }
      )
    }
    logger.error("Password reset failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 })
  }
}
