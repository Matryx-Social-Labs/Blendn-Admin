import { clientIpFrom } from "@/lib/client-ip"
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import { emailDomain } from "@/lib/org-invites"
import { sendEmail, passwordResetEmail, emailConfigured } from "@/lib/email"
import { issuePasswordResetLink } from "@/lib/password-reset"

/**
 * Request a password reset.
 *
 * The approval email hands a new host a generated password and tells them to
 * change it. Until now there was no reset flow at all, so anyone who lost it had
 * one route back: emailing support.
 *
 * **The response is identical whether or not the address has an account.** A
 * reset form that says "no account with that email" is an account-enumeration
 * oracle — feed it a list, learn who is a customer. So every outcome returns the
 * same body and roughly the same timing.
 */

/** One hour. Short, because this token changes a credential. */
const RESET_TTL_MS = 60 * 60 * 1000

export async function POST(req: NextRequest) {
  // Two limits. Per-IP stops someone walking a list of addresses; the
  // per-address limit below stops one victim being mailbombed from many IPs.
  const limited = await rateLimit(req, {
    windowMs: 15 * 60 * 1000,
    maxRequests: 5,
    keyGenerator: (r) =>
      `auth:forgot:${clientIpFrom(r.headers)}`,
  })
  if (limited) return limited

  // Said no matter what happens below.
  const ok = NextResponse.json({
    ok: true,
    message: "If that address has an account, a reset link is on its way.",
  })

  try {
    const { email } = (await req.json()) as { email?: string }
    const address = email?.trim().toLowerCase()
    if (!address || !emailDomain(address)) return ok

    const perAddress = await rateLimit(req, {
      windowMs: 60 * 60 * 1000,
      maxRequests: 3,
      keyGenerator: () => `auth:forgot:addr:${address}`,
    })
    if (perAddress) return perAddress

    const user = await db.user.findUnique({
      where: { email: address },
      select: { id: true, name: true, role: true, deletedAt: true, suspended_at: true },
    })

    /*
     * Silent no-ops, all returning `ok`:
     *  - no such account
     *  - a deleted account
     * A suspended host CAN reset; suspension is not a lockout of the credential.
     *
     * Attendees used to be excluded here, on the reasoning that they "have no
     * dashboard to sign in to". That stopped being true the moment the mobile
     * app grew a password sign-in: an attendee is now exactly the person most
     * likely to need this, and every mobile user is an attendee. The exclusion
     * would have silently swallowed every reset request the app ever made,
     * while still returning `ok` — the worst possible failure, because the app
     * would show "check your email" for a mail that was never sent.
     *
     * Nothing downstream needed changing: `/api/auth/reset-password` already
     * revokes `mobile_refresh_tokens` when the password changes.
     */
    if (!user || user.deletedAt) return ok

    // Outstanding tokens for this user are spent. Otherwise requesting a second
    // link leaves the first one live, and the older mail is the one more likely
    // to have been forwarded or left sitting somewhere.
    const link = await issuePasswordResetLink(user.id, RESET_TTL_MS)

    if (emailConfigured()) {
      const result = await sendEmail({
        to: address,
        ...passwordResetEmail(user.name ?? "there", link),
      })
      if (!result.sent) {
        logger.error("Password reset email failed", { userId: user.id, reason: result.reason })
      }
    }

    /*
     * SCRUM-195 diagnostic, one release only: the audit rows show Railway's
     * edge address where the client's should be, and nothing in the app can
     * see the raw chain. Logged here because this route is unauthenticated
     * and audited, so one curl proves both the format and the reader.
     */
    logger.info("Client address headers", {
      xff: req.headers.get("x-forwarded-for"),
      envoyExternal: req.headers.get("x-envoy-external-address"),
      realIp: req.headers.get("x-real-ip"),
      cfConnecting: req.headers.get("cf-connecting-ip"),
      picked: getRequestIp(req),
    })

    auditLog({
      userId: user.id,
      action: "auth.password_reset_requested",
      resource: "user",
      resourceId: user.id,
      ipAddress: getRequestIp(req),
    })

    return ok
  } catch (err) {
    logger.error("Forgot-password failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    // Even a crash returns the same body — an error here would otherwise
    // distinguish "real address, something broke" from "no such address".
    return ok
  }
}
