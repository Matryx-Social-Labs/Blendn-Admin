import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import {
  accountBlockReason,
  verifyAppleIdToken,
  findOrCreateAppleUser,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
  SUSPENDED_MESSAGE,
} from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import {
  successResponse,
  errorResponse,
  forbiddenResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { normalizeLocationToCity } from "@/lib/location"

const appleAuthSchema = z.object({
  identityToken: z.string().min(1, "Identity token is required"),
  fullName: z
    .object({
      givenName: z.string().nullable().optional(),
      familyName: z.string().nullable().optional(),
    })
    .optional(),
  deviceInfo: z
    .object({
      platform: z.string().optional(),
      device: z.string().optional(),
      appVersion: z.string().optional(),
    })
    .optional(),
})

export async function POST(request: NextRequest) {
  const rateLimitResult = await rateLimit(request, createAuthRateLimit("apple"))
  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await request.json()

    const validation = appleAuthSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { identityToken, fullName, deviceInfo } = validation.data

    const applePayload = await verifyAppleIdToken(identityToken)
    if (!applePayload) {
      return errorResponse("Invalid or expired Apple identity token", 401)
    }

    const { userId, email, isNewUser } = await findOrCreateAppleUser(applePayload, fullName)

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
    if (blocked === "suspended") return forbiddenResponse(SUSPENDED_MESSAGE)
    // `!user` is already covered by `blocked === "deleted"`; naming it again is
    // what narrows the type for everything below.
    if (blocked || !user) return errorResponse("Account not found", 401)

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
            ? {
                ...user.profile,
                location: normalizedLocation,
              }
            : null,
        },
        accessToken,
        refreshToken,
        isNewUser,
      },
      isNewUser ? 201 : 200
    )
  } catch (error) {
    logger.error("Apple auth error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to authenticate with Apple")
  }
}
