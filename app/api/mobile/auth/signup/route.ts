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
  conflictResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { signupSchema } from "@/lib/validations/auth"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = await rateLimit(request, createAuthRateLimit("signup"))
  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await request.json()

    // Validate input
    const parsed = signupSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { email, password, name, deviceInfo } = parsed.data

    // Check if user already exists
    const existingUser = await db.user.findUnique({
      where: { email },
    })

    if (existingUser) {
      return conflictResponse("Email already registered")
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12)

    // Create user
    const user = await db.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
      },
    })

    // Create profile
    await db.profiles.create({
      data: {
        id: user.id,
        name,
        onboarded: false,
      },
    })

    // Generate tokens
    const accessToken = signAccessToken(user.id, user.email)
    const refreshToken = signRefreshToken(user.id, user.email)

    // Store refresh token
    await storeRefreshToken(user.id, refreshToken, deviceInfo)

    return successResponse(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        accessToken,
        refreshToken,
      },
      201
    )
  } catch (error) {
    logger.error("Signup error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to create account")
  }
}
