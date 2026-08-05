import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import {
  verifyGoogleIdToken,
  findOrCreateGoogleUser,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
} from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { normalizeLocationToCity } from "@/lib/location"

const googleAuthSchema = z.object({
  idToken: z.string().min(1, "ID token is required"),
  deviceInfo: z
    .object({
      platform: z.string().optional(),
      device: z.string().optional(),
      appVersion: z.string().optional(),
    })
    .optional(),
})

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = await rateLimit(request, createAuthRateLimit("google"))
  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await request.json()

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

    // Generate tokens
    const accessToken = signAccessToken(userId, email)
    const refreshToken = signRefreshToken(userId, email)

    // Store refresh token
    await storeRefreshToken(userId, refreshToken, deviceInfo)

    // Get user with profile
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        emailVerified: true,
        createdAt: true,
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

    const normalizedLocation = await normalizeLocationToCity(user?.profile?.location)

    return successResponse(
      {
        user: user
          ? {
              ...user,
              profile: user.profile
                ? {
                    ...user.profile,
                    location: normalizedLocation,
                  }
                : null,
            }
          : null,
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
