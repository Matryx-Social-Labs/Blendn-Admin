import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"
import { db } from "@/lib/db"
import {
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
} from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { signinSchema } from "@/lib/validations/auth"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { normalizeLocationToCity } from "@/lib/location"

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = rateLimit(request, createAuthRateLimit("signin"))
  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await request.json()

    // Validate input
    const parsed = signinSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { email, password, deviceInfo } = parsed.data

    // Find user
    const user = await db.user.findUnique({
      where: { email },
      include: {
        profile: true,
      },
    })

    if (!user || !user.password) {
      return unauthorizedResponse("Invalid email or password")
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password)
    if (!isValidPassword) {
      return unauthorizedResponse("Invalid email or password")
    }

    // Generate tokens
    const accessToken = signAccessToken(user.id, user.email)
    const refreshToken = signRefreshToken(user.id, user.email)

    // Store refresh token
    await storeRefreshToken(user.id, refreshToken, deviceInfo)

    const normalizedLocation = await normalizeLocationToCity(user.profile?.location)

    return successResponse({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        profile: user.profile
          ? {
              ...user.profile,
              location: normalizedLocation,
            }
          : null,
      },
      accessToken,
      refreshToken,
    })
  } catch (error) {
    logger.error("Signin error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to sign in")
  }
}
