import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import {
  verifyAppleIdToken,
  findOrCreateAppleUser,
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

    const accessToken = signAccessToken(userId, email)
    const refreshToken = signRefreshToken(userId, email)

    await storeRefreshToken(userId, refreshToken, deviceInfo)

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
    logger.error("Apple auth error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to authenticate with Apple")
  }
}
