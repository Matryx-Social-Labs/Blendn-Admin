import { logger } from "@/lib/logger"
import jwt from "jsonwebtoken"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import {
  accountBlockReason,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  SUSPENDED_MESSAGE,
} from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { refreshTokenSchema } from "@/lib/validations/auth"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = await rateLimit(request, createAuthRateLimit("refresh"))
  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await request.json()

    // Validate input
    const parsed = refreshTokenSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { refreshToken: oldRefreshToken } = parsed.data

    // Verify the refresh token
    const decoded = await verifyRefreshToken(oldRefreshToken)
    if (!decoded) {
      return unauthorizedResponse("Invalid or expired refresh token")
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
    if (blocked === "suspended") return forbiddenResponse(SUSPENDED_MESSAGE)
    // `!user` is already covered by `blocked === "deleted"`; naming it again is
    // what narrows the type for everything below.
    if (blocked || !user) return unauthorizedResponse("User not found")

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
