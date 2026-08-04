import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import {
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
} from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { refreshTokenSchema } from "@/lib/validations/auth"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = rateLimit(request, createAuthRateLimit("refresh"))
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

    if (!user || user.deletedAt) {
      return unauthorizedResponse("User not found")
    }

    // Revoke the old refresh token (token rotation)
    await revokeRefreshToken(oldRefreshToken)

    // Generate new tokens
    const accessToken = signAccessToken(user.id, user.email)
    const refreshToken = signRefreshToken(user.id, user.email)

    // Store new refresh token
    await storeRefreshToken(user.id, refreshToken)

    return successResponse({
      accessToken,
      refreshToken,
    })
  } catch (error) {
    logger.error("Token refresh error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to refresh token")
  }
}
