import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"
import { profileForSelfResponse } from "@/lib/self-profile"
import { db } from "@/lib/db"
import {
  accountBlockReason,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
  SUSPENDED_MESSAGE,
} from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { signinSchema } from "@/lib/validations/auth"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { normalizeLocationToCity } from "@/lib/location"

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = await rateLimit(request, createAuthRateLimit("signin"))
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

    /*
     * A second limit, keyed on the account rather than the caller.
     *
     * The limit above is per-IP, and `createAuthRateLimit` cannot do better —
     * its `keyGenerator` is synchronous and runs before the body is read. That
     * was survivable while no client could reach this route with a password. It
     * stops being survivable the moment the app ships a password form: per-IP
     * alone lets a distributed attempt walk one account's password from a
     * thousand addresses without ever tripping a counter.
     *
     * Same shape as the per-address limit in `/api/auth/forgot-password`.
     * Deliberately looser than that one (10/15min vs 3/hr) because this is a
     * person mistyping their own password, not a mailbomb.
     */
    const perAccount = await rateLimit(request, {
      windowMs: 15 * 60 * 1000,
      maxRequests: 10,
      keyGenerator: () => `auth:signin:acct:${email.trim().toLowerCase()}`,
    })
    if (perAccount) return perAccount

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

    /*
     * Checked after the password, deliberately.
     *
     * Refusing a suspended account before verifying the credential would turn
     * this route into an oracle: anyone could learn which addresses are
     * suspended without knowing a password. Suspension is not secret from the
     * person suspended, but it is not public either.
     *
     * A deleted account cannot reach here — deletion nulls `password`, so the
     * `!user.password` branch above already returned. The reason is handled
     * anyway rather than assumed, because that is a property of a different
     * file.
     */
    const blocked = accountBlockReason(user)
    if (blocked === "suspended") return forbiddenResponse(SUSPENDED_MESSAGE)
    if (blocked) return unauthorizedResponse("Invalid email or password")

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
        // The same shape /auth/session returns. The app stores this object and
        // reads `image` off it to decide whether a reveal would show anything;
        // without it, someone with a photo was told to add one until the next
        // session check happened to overwrite the stored copy.
        image: user.image,
        profile: user.profile
          ? { ...profileForSelfResponse(user.profile), location: normalizedLocation }
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
