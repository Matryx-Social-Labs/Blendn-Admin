import { createHash } from "node:crypto"

import { clientIpFrom } from "@/lib/client-ip"
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import { emailDomain } from "@/lib/org-invites"
import { sendEmail, passwordResetEmail, emailConfigured } from "@/lib/email"
import { issuePasswordResetLink } from "@/lib/password-reset"
import { readJson } from "@/lib/api-input"

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

/**
 * The one form of an address this route uses, for the lookup and the limit
 * alike: trimmed and lower-cased, which is how every account's address is
 * stored (SCRUM-328) and how sign-in looks it up. No Unicode folding and no
 * `+tag` stripping: either would make two stored accounts one string, and the
 * lookup is an exact match on the stored form. Anything not a string is "".
 */
function canonicalEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : ""
}

/**
 * Every answer takes at least this long, and the email goes after it (step 18
 * security review, L3): an address with an account did a database write and a
 * mail send that one without did not, and the difference was a clock.
 */
const MIN_RESPONSE_MS = 600

async function padded<T>(started: number, response: T): Promise<T> {
  const wait = MIN_RESPONSE_MS - (Date.now() - started)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  return response
}

export async function POST(req: NextRequest) {
  const started = Date.now()
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
    const { email } = ((await readJson(req)) ?? {}) as { email?: unknown }
    const address = canonicalEmail(email)
    if (!address || !emailDomain(address)) return padded(started, ok)

    /*
     * Three mails an hour per address, and over that the same "ok" with
     * nothing issued and nothing sent (L3 and the scan after it).
     *
     * This answered a 429, which let a stranger refuse the owner's own request
     * for the hour. Now the cap only stops mail. Nothing over it issues a
     * token either — issuing spends the outstanding one — so the newest link
     * that was mailed stays good for its full hour: three requests from a
     * stranger put three links in the owner's inbox and take nothing away.
     * The window is fixed, not sliding (lib/rate-limit-store.ts `hit`), so a
     * steady trickle cannot hold it shut; the per-network limit above stays.
     *
     * The key is the hash of the very string the account is looked up by, so
     * one bucket is one account: no variant of an address reaches the same
     * account through a different bucket, and no two accounts share one.
     */
    const capped = await rateLimit(req, {
      windowMs: 60 * 60 * 1000,
      maxRequests: 3,
      keyGenerator: () => `auth:forgot:addr:${createHash("sha256").update(address).digest("hex")}`,
    })
    if (capped) return padded(started, ok)

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
    if (!user || user.deletedAt) return padded(started, ok)

    // Outstanding tokens for this user are spent. Otherwise requesting a second
    // link leaves the first one live, and the older mail is the one more likely
    // to have been forwarded or left sitting somewhere.
    const link = await issuePasswordResetLink(user.id, RESET_TTL_MS)

    if (emailConfigured()) {
      // After the response, never awaited by it (L3).
      void sendEmail({ to: address, ...passwordResetEmail(user.name ?? "there", link) })
        .then((result) => {
          if (!result.sent) logger.error("Password reset email failed", { userId: user.id, reason: result.reason })
        })
        .catch((error: unknown) => logger.error("Password reset email failed", { userId: user.id, error: String(error) }))
    }

    auditLog({
      userId: user.id,
      action: "auth.password_reset_requested",
      resource: "user",
      resourceId: user.id,
      ipAddress: getRequestIp(req),
    })

    return padded(started, ok)
  } catch (err) {
    logger.error("Forgot-password failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    // Even a crash returns the same body — an error here would otherwise
    // distinguish "real address, something broke" from "no such address".
    return padded(started, ok)
  }
}
