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
  errorResponse,
  ErrorCode,
} from "@/lib/api-response"
import { signupSchema } from "@/lib/validations/auth"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { checkPassword } from "@/lib/password"
import { normalizeLocationToCity } from "@/lib/location"

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

    const { email, password, name, age, deviceInfo } = parsed.data

    /*
     * The same check `/api/auth/reset-password` runs, so signup and reset
     * enforce one rule rather than two.
     *
     * The zod schema above already covers length. This adds what length alone
     * cannot: `password1234` is twelve characters and would otherwise sail
     * through, and so would a password built out of the user's own address.
     */
    const passwordCheck = checkPassword(password, email)
    if (!passwordCheck.ok) {
      return errorResponse(
        passwordCheck.message ?? "Choose a stronger password",
        400,
        ErrorCode.VALIDATION_FAILED
      )
    }

    // Check if user already exists
    const existingUser = await db.user.findUnique({
      where: { email },
    })

    if (existingUser) {
      return conflictResponse("Email already registered")
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12)

    /*
     * One transaction, because a `User` without a `profiles` row is a broken
     * account rather than a partial one.
     *
     * These were two sequential creates. A failure between them left a user who
     * could authenticate but whose profile lookup returned null — and the app's
     * routing gate reads `profile.onboarded` to decide where to send someone,
     * so that account lands nowhere and cannot be recovered by signing in again
     * (the email is taken, so signup now 409s).
     */
    const { user, profile } = await db.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
        },
      })

      const createdProfile = await tx.profiles.create({
        data: {
          id: createdUser.id,
          name,
          /*
           * Captured here because there is nowhere else it can be. Google and
           * Apple create profiles with no age (`lib/mobile-auth.ts`), the
           * eight onboarding screens that used to ask are being deleted, and
           * the roster displays it. Undefined until the app sends it, which is
           * why the field is optional for now.
           */
          age,
          onboarded: false,
        },
      })

      return { user: createdUser, profile: createdProfile }
    })

    // Generate tokens
    const accessToken = signAccessToken(user.id, user.email)
    const refreshToken = signRefreshToken(user.id, user.email)

    // Store refresh token
    await storeRefreshToken(user.id, refreshToken, deviceInfo)

    /*
     * Return `profile`, the same shape signin returns.
     *
     * It was omitted, so a client that signed up got a `user` without a profile
     * while a client that signed in got one — and the app reads
     * `user.profile.onboarded` to decide where to route. Without it the client
     * has to make a second call before it can navigate, on the one screen where
     * a spinner is least welcome.
     */
    const normalizedLocation = await normalizeLocationToCity(profile.location)

    return successResponse(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          profile: { ...profile, location: normalizedLocation },
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
