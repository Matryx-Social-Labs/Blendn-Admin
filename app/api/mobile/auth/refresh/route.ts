import { logger } from "@/lib/logger"
import { accountRefusal } from "@/lib/account-refusal"
import jwt from "jsonwebtoken"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import {
  accountBlockReason,
  revokedBySuspension,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokedSessionCode,
  belongsToDeletedAccount,
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
    if (!decoded) {
      // A session the suspension ended is told why, not just refused: the
      // suspension revoked this very token, so without it the suspended check
      // below is unreachable (SCRUM-290). Scoped in `revokedBySuspension`.
      if (await revokedBySuspension(oldRefreshToken)) return accountRefusal("suspended")
      if (await belongsToDeletedAccount(oldRefreshToken)) {
        return errorResponse("Invalid or expired refresh token", 401, ErrorCode.ACCOUNT_DELETED, ErrorCode.ACCOUNT_DELETED)
      }
      // And one a password reset or a sign-out-everywhere ended, told why (Flow 15):
      // the sentence stays the generic one, the code is the reason.
      const sessionCode = await revokedSessionCode(oldRefreshToken)
      return errorResponse("Invalid or expired refresh token", 401, sessionCode ?? ErrorCode.UNAUTHORIZED, sessionCode ?? undefined)
    }

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
    if (blocked === "suspended" || blocked === "staff") return accountRefusal(blocked)
    // `!user` is already covered by `blocked === "deleted"`; naming it again is
    // what narrows the type for everything below.
    if (blocked || !user) return errorResponse("User not found", 401, ErrorCode.ACCOUNT_DELETED, ErrorCode.ACCOUNT_DELETED)

    // Generate new tokens
    const accessToken = signAccessToken(user.id, user.email)
    const refreshToken = signRefreshToken(user.id, user.email)

    // Store the new one, then retire the old one pointing at it — so a replay
    // of the old token inside the grace window can find and revoke the
    // successor the client never received.
    await storeRefreshToken(user.id, refreshToken)
    await revokeRefreshToken(oldRefreshToken, (jwt.decode(refreshToken) as { jti?: string } | null)?.jti)

    return successResponse({
      accessToken,
      refreshToken,
    })
  } catch (error) {
    logger.error("Token refresh error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to refresh token")
  }
}
