import bcrypt from "bcryptjs"

import { errorResponse, ErrorCode } from "./api-response"
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
/** Sign-in's numbers, so a stolen bearer token does not make this route the softer password oracle (review). */
const PASSWORD_TRIES = 5
const PASSWORD_WINDOW_MS = 15 * 60 * 1000

export interface DeletionProof {
  password?: string
  googleIdToken?: string
  appleIdentityToken?: string
}

const reauth = () => errorResponse("Sign in again to delete your account.", 403, ErrorCode.REAUTH_REQUIRED)

/** Null when the deletion may go ahead; otherwise the refusal to send. */
export async function deletionReauthRefusal(userId: string, proof: DeletionProof): Promise<Response | null> {
  if (proof.password !== undefined) {
    // Every try takes a slot; a right one deletes the account, so there is nothing to give back.
    const tries = await hit(`rl:account-delete:password:${userId}`, PASSWORD_WINDOW_MS, { failClosed: true })
    if (tries.count > PASSWORD_TRIES) {
      logger.warn("Account deletion: too many wrong passwords", { userId })
      return errorResponse("Too many tries. Try again later.", 429, ErrorCode.RATE_LIMITED)
    }
    const user = await db.user.findUnique({ where: { id: userId }, select: { password: true } })
    const right = user?.password ? await bcrypt.compare(proof.password, user.password) : false
    if (right) return null
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
      logger.warn("Account deletion: provider token refused (invalid or stale)", { userId, provider })
      return reauth()
    }
    const linked = await db.user_oauth_accounts.findFirst({
      where: { user_id: userId, provider, provider_id: payload.sub },
      select: { id: true },
    })
    if (linked) return null
    logger.warn("Account deletion: provider token not linked to this account", { userId, provider })
    return reauth()
  }
  if (minimumAtLeast(DELETION_REAUTH_FROM_VERSION)) return reauth()
  logger.info("Account deleted with no re-auth proof (a build older than the one that sends it)", { userId })
  return null
}
