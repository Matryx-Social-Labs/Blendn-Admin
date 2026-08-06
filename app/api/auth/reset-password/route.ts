import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import { hashInviteToken } from "@/lib/org-invites"
import { checkPassword } from "@/lib/password"

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

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, {
    windowMs: 15 * 60 * 1000,
    maxRequests: 10,
    keyGenerator: (r) =>
      `auth:reset:${r.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"}`,
  })
  if (limited) return limited

  try {
    const { token, password } = (await req.json()) as { token?: string; password?: string }

    // One message for every token failure. Distinguishing "no such token" from
    // "expired" tells someone probing which of their guesses were once real.
    const invalid = NextResponse.json(
      { error: "This reset link is invalid or has expired. Request a new one." },
      { status: 400 }
    )
    if (!token || !password) return invalid

    const row = await db.password_reset_tokens.findUnique({
      where: { token_hash: hashInviteToken(token) },
      select: {
        token_hash: true,
        used_at: true,
        expires_at: true,
        user: { select: { id: true, email: true, deletedAt: true } },
      },
    })
    if (!row || row.used_at || row.expires_at.getTime() <= Date.now()) return invalid
    if (row.user.deletedAt) return invalid

    // Checked here as well as in the form — the form's copy of the rule is a
    // courtesy, this is the rule.
    const check = checkPassword(password, row.user.email)
    if (!check.ok) return NextResponse.json({ error: check.message }, { status: 400 })

    const hashed = await bcrypt.hash(password, 12)

    await db.$transaction(async (tx) => {
      // Claiming with `used_at: null` in the filter is the concurrency guard:
      // the second of two simultaneous submissions matches zero rows.
      const claimed = await tx.password_reset_tokens.updateMany({
        where: { token_hash: row.token_hash, used_at: null },
        data: { used_at: new Date() },
      })
      if (claimed.count === 0) throw new Error("ALREADY_USED")

      await tx.user.update({ where: { id: row.user.id }, data: { password: hashed } })

      // The point of resetting after a compromise.
      await tx.mobile_refresh_tokens.updateMany({
        where: { user_id: row.user.id, revoked_at: null },
        data: { revoked_at: new Date() },
      })
    })

    auditLog({
      userId: row.user.id,
      action: "auth.password_reset_completed",
      resource: "user",
      resourceId: row.user.id,
      ipAddress: getRequestIp(req),
    })

    return NextResponse.json({ ok: true })
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
