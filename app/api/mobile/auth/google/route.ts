import { logger } from "@/lib/logger"
import { accountRefusal } from "@/lib/account-refusal"
import { NextRequest } from "next/server"
import { z } from "zod"
import {
  accountBlockReason,
  verifyGoogleIdToken,
  findOrCreateGoogleUser,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
} from "@/lib/mobile-auth"
import { profileForSelfResponse } from "@/lib/self-profile"
import { db } from "@/lib/db"
import {
  successResponse,
  errorResponse,
  ErrorCode,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { normalizeLocationToCity } from "@/lib/location"
import { readJson } from "@/lib/api-input"
import { deviceInfoSchema } from "@/lib/validations/auth"

const googleAuthSchema = z.object({
  idToken: z.string().min(1, "ID token is required"),
  deviceInfo: deviceInfoSchema.optional(),
})

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = await rateLimit(request, createAuthRateLimit("google"))
  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await readJson(request)

    // Validate request body
    const validation = googleAuthSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { idToken, deviceInfo } = validation.data

    // Verify the Google ID token
    const googlePayload = await verifyGoogleIdToken(idToken)
    if (!googlePayload) {
      return errorResponse("Invalid or expired Google token", 401)
    }

    // Find or create user from Google OAuth
    const { userId, email, isNewUser } = await findOrCreateGoogleUser(googlePayload)

    /*
     * Loaded before the tokens are signed, not after.
     *
     * The order used to be sign, store, then fetch — which is fine while the
     * fetch only shapes a response, and wrong the moment it decides whether the
     * session should exist. A suspended account would have walked away with a
     * valid 30-day refresh token before anything looked at `suspended_at`.
     */
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        emailVerified: true,
        createdAt: true,
        deletedAt: true,
        suspended_at: true,
        role: true,
        profile: {
          select: {
            phone: true,
            name: true,
            age: true,
            location: true,
            interests: true,
            onboarded: true,
          },
        },
      },
    })

    const blocked = accountBlockReason(user)
    if (blocked === "suspended" || blocked === "staff") return accountRefusal(blocked)
    // `!user` is already covered by `blocked === "deleted"`; naming it again is
    // what narrows the type for everything below.
    if (blocked || !user) return errorResponse("Account not found", 401, ErrorCode.ACCOUNT_DELETED, ErrorCode.ACCOUNT_DELETED)

    const accessToken = signAccessToken(userId, email)
    const refreshToken = signRefreshToken(userId, email)

    await storeRefreshToken(userId, refreshToken, deviceInfo)

    const normalizedLocation = await normalizeLocationToCity(user.profile?.location)

    return successResponse(
      {
        // Field by field rather than a spread: `user` now carries `deletedAt`
        // and `suspended_at`, and neither belongs in a response.
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          emailVerified: user.emailVerified,
          createdAt: user.createdAt,
          profile: user.profile
            ? { ...profileForSelfResponse(user.profile), location: normalizedLocation }
            : null,
        },
        accessToken,
        refreshToken,
        isNewUser,
      },
      isNewUser ? 201 : 200
    )
  } catch (error) {
    logger.error("Google auth error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to authenticate with Google")
  }
}
