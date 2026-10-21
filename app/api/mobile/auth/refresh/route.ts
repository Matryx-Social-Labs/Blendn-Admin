import { logger } from "@/lib/logger"
import { accountRefusal } from "@/lib/account-refusal"
import jwt from "jsonwebtoken"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import {
  accountBlockReason,
  hashRefreshToken,
  refusedRefreshReason,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
  verifyRefreshToken,
} from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  errorResponse,
  ErrorCode,
  serverErrorResponse,
} from "@/lib/api-response"
import { refreshTokenSchema } from "@/lib/validations/auth"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { readJson } from "@/lib/api-input"

/**
 * A refused refresh token, with the reason when its holder may be told one
 * (`refusedRefreshReason`): the sentence stays the generic one, the code is why.
 */
async function refusedRefresh(token: string) {
  const reason = await refusedRefreshReason(token)
  if (reason === "ACCOUNT_SUSPENDED") return accountRefusal("suspended")
  if (reason) return errorResponse("Invalid or expired refresh token", 401, reason, reason)
  return errorResponse("Invalid or expired refresh token", 401, ErrorCode.UNAUTHORIZED)
}

function accountBlockedResponse(reason: "deleted" | "suspended" | "staff") {
  if (reason === "deleted") return errorResponse("User not found", 401, ErrorCode.ACCOUNT_DELETED, ErrorCode.ACCOUNT_DELETED)
  return accountRefusal(reason)
}

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = await rateLimit(request, createAuthRateLimit("refresh"))
  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await readJson(request)

    // Validate input
    const parsed = refreshTokenSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { refreshToken: oldRefreshToken } = parsed.data

    // Verify the refresh token
    const decoded = await verifyRefreshToken(oldRefreshToken)
    if (!decoded) return refusedRefresh(oldRefreshToken)

    // Check if user still exists
    const user = await db.user.findUnique({
      where: { id: decoded.userId },
    })

    /*
     * The boundary that actually enforces a suspension.
     *
     * Access tokens are 15 minutes and are verified without a database read, so
     * this — plus revoking refresh tokens at the moment of suspension — is what
     * bounds a suspended session's remaining life. Refusing here without
     * rotating means the token they are holding stays revoked-free but useless.
     */
    const blocked = accountBlockReason(user)
    if (blocked) return accountBlockedResponse(blocked)
    // `!user` is already covered by `blocked === "deleted"`; naming it again is
    // what narrows the type for everything below.
    if (!user) return accountBlockedResponse("deleted")

    // Generate new tokens
    const accessToken = signAccessToken(user.id, user.email)
    const refreshToken = signRefreshToken(user.id, user.email)
    const newJti = (jwt.decode(refreshToken) as { jti?: string } | null)?.jti
    // Hashed before the lock below: bcrypt must not run while a row is held.
    const tokenHash = await hashRefreshToken(refreshToken)

    /*
     * Store the new one and retire the old one pointing at it — so a replay of
     * the old token inside the grace window can find and revoke the successor
     * the client never received — in one transaction that holds the user row
     * `FOR SHARE`.
     *
     * Without the lock this raced "sign out everywhere", the feature that exists
     * to end other phones' sessions: that revoked the rows live at its
     * `updateMany`, a refresh in flight stored its new row just after, and the
     * phone kept a live session (and an access token issued after the stamp)
     * the person had just ended. `endPhoneSessions` takes the same row
     * `FOR NO KEY UPDATE` first and reads its stamp after it, so one of two
     * things holds: this committed first, and its new row is revoked by
     * theirs; or theirs committed first, and the checks below see it. The
     * suspension and deletion are checked again under the lock for the same reason.
     */
    const outcome = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE id = ${user.id} FOR SHARE`
      const current = await tx.user.findUnique({
        where: { id: user.id },
        select: { id: true, deletedAt: true, suspended_at: true, role: true },
      })
      const blockedNow = accountBlockReason(current)
      if (blockedNow) return { kind: "blocked", reason: blockedNow } as const
      /*
       * Ended since the check above? `endPhoneSessions` revokes every live row of
       * the account, with its reason, under the lock this holds: so this token's
       * own row says whether a sign-out or a reset landed in between. (Not the
       * stamp against the token's `iat`: that is second-grained, and refused a
       * token signed in the same second after the stamp for its whole life.)
       */
      const own = await tx.mobile_refresh_tokens.findUnique({ where: { id: decoded.jti }, select: { revoked_reason: true } })
      if (!own || own.revoked_reason) return { kind: "ended" } as const

      await storeRefreshToken(user.id, refreshToken, undefined, { client: tx, tokenHash })
      await tx.mobile_refresh_tokens.updateMany({
        where: { id: decoded.jti },
        data: { revoked_at: new Date(), ...(newJti ? { replaced_by: newJti } : {}) },
      })
      return { kind: "ok" } as const
    })
    if (outcome.kind === "blocked") return accountBlockedResponse(outcome.reason)
    if (outcome.kind === "ended") return refusedRefresh(oldRefreshToken)

    return successResponse({
      accessToken,
      refreshToken,
    })
  } catch (error) {
    logger.error("Token refresh error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to refresh token")
  }
}
