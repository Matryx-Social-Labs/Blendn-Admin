import bcrypt from "bcryptjs"
import { createHash } from "crypto"

import { errorResponse, ErrorCode } from "./api-response"
import { auditLog } from "./audit-log"
import { emailKeysFor, mobileAccountKey, refuseOverEmailLimits } from "./dashboard-signin-limits"
import { db } from "./db"
import { logger } from "./logger"
import { minimumAtLeast } from "./mobile-gate"
import { hit } from "./rate-limit-store"
import { verifyAppleIdToken, verifyGoogleIdToken } from "./mobile-auth"

/*
 * Who is deleting (SCRUM-944 (3), owner ruling A-18, 2026-11-01). A bearer token alone deleted the account, so anyone
 * holding a phone that was signed in could end it. Now the request proves it: a password account its password, an SSO
 * account a Google or Apple identity token issued in the last 15 minutes and linked to it (a fresh sign-in sheet).
 *
 * A request with no proof is today's answer until MOBILE_MIN_APP_VERSION reaches the build that sends one, because
 * every older build must still be able to delete in-app (App Store 5.1.1(v)). Raise the minimum to retire it.
 */
export const DELETION_REAUTH_FROM_VERSION = "1.0.1"
const FRESH_SECONDS = 15 * 60
/** Mobile sign-in's per-account window (app/api/mobile/auth/signin): the same key, so both doors share one budget. */
const ACCOUNT_TRIES = 10
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000

export interface DeletionProof {
  password?: string
  googleIdToken?: string
  appleIdentityToken?: string
}

const reauth = () => errorResponse("Sign in again to delete your account.", 403, ErrorCode.REAUTH_REQUIRED)
const tooMany = () => errorResponse("Too many tries. Try again later.", 429, ErrorCode.RATE_LIMITED)
/** Every refusal is an audit row: a stolen bearer token guessing here should be visible (security review). */
const failed = (userId: string, method: string, why: string) =>
  auditLog({ userId, action: "account.delete_reauth_failed", resource: "user", resourceId: userId, details: { method, why } })

/** Null when the deletion may go ahead; otherwise the refusal to send. */
export async function deletionReauthRefusal(userId: string, proof: DeletionProof): Promise<Response | null> {
  if (proof.password !== undefined) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { password: true, email: true } })
    if (!user) return reauth()
    /*
     * In sign-in's own windows (the mobile per-account one and the shared per-email ones), counted before the check as
     * sign-in counts them: a stolen bearer token gets no more guesses here than at the sign-in door, and they share one
     * budget. A right password deletes the account, so there is nothing to give back.
     */
    try {
      await refuseOverEmailLimits(emailKeysFor(user.email))
    } catch {
      failed(userId, "password", "rate_limited")
      return tooMany()
    }
    const account = await hit(`rl:${mobileAccountKey(user.email)}`, ACCOUNT_WINDOW_MS, { failClosed: true })
    if (account.count > ACCOUNT_TRIES) {
      failed(userId, "password", "rate_limited")
      return tooMany()
    }
    const right = user.password ? await bcrypt.compare(proof.password, user.password) : false
    if (right) return null
    failed(userId, "password", "wrong")
    logger.warn("Account deletion: wrong password", { userId })
    return errorResponse("That password is not right.", 403, ErrorCode.PASSWORD_INCORRECT)
  }
  if (proof.appleIdentityToken !== undefined || proof.googleIdToken !== undefined) {
    const provider = proof.appleIdentityToken !== undefined ? "apple" : "google"
    const payload =
      provider === "apple"
        ? await verifyAppleIdToken(proof.appleIdentityToken!)
        : await verifyGoogleIdToken(proof.googleIdToken!)
    const issuedAt = Number(payload?.iat)
    if (!payload?.sub || !Number.isFinite(issuedAt) || Date.now() / 1000 - issuedAt > FRESH_SECONDS) {
      failed(userId, provider, "invalid_or_stale")
      logger.warn("Account deletion: provider token refused (invalid or stale)", { userId, provider })
      return reauth()
    }
    const linked = await db.user_oauth_accounts.findFirst({
      where: { user_id: userId, provider, provider_id: payload.sub },
      select: { id: true },
    })
    if (!linked) {
      failed(userId, provider, "not_linked")
      logger.warn("Account deletion: provider token not linked to this account", { userId, provider })
      return reauth()
    }
    /*
     * Once: the token's hash is held for its 15 minutes, taken atomically before the erasure, so a captured token cannot
     * be replayed (a server nonce is the post-launch follow-up, SCRUM-944). Audience and issuer are the verifiers' checks.
     */
    const token = (proof.appleIdentityToken ?? proof.googleIdToken)!
    const once = await hit(`rl:account-delete:token:${createHash("sha256").update(token).digest("hex")}`, FRESH_SECONDS * 1000, {
      failClosed: true,
    })
    if (once.count > 1) {
      failed(userId, provider, "replayed")
      return reauth()
    }
    return null
  }
  if (minimumAtLeast(DELETION_REAUTH_FROM_VERSION)) return reauth()
  logger.info("Account deleted with no re-auth proof (a build older than the one that sends it)", { userId })
  return null
}
