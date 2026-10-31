import { logger } from "@/lib/logger"
import { accountRefusal } from "@/lib/account-refusal"
import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"
import {
  DUMMY_HASH,
  emailKeysFor,
  mobileAccountKey,
  refuseOverEmailLimits,
  releaseMobileAccountAttempt,
  settleSigninSuccess,
} from "@/lib/dashboard-signin-limits"
import { SIGNIN_ACCOUNT_LOCKED } from "@/lib/rbac"
import { profileForSelfResponse } from "@/lib/self-profile"
import { db } from "@/lib/db"
import {
  accountBlockReason,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
} from "@/lib/mobile-auth"
import {
  ErrorCode,
  errorResponse,
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { signinSchema } from "@/lib/validations/auth"
import { isKnownDeviceProof, knownDeviceCookie } from "@/lib/known-device"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"
import { normalizeLocationToCity } from "@/lib/location"
import { readJson } from "@/lib/api-input"

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = await rateLimit(request, createAuthRateLimit("signin"))
  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await readJson(request)

    // Validate input
    const parsed = signinSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { email, password, deviceInfo } = parsed.data
    /*
     * A phone that has signed in to this account before skips the two per-email windows below, so a stranger's wrong
     * guesses cannot lock its owner out (owner ruling A-18 (1); the dashboard's cookie, lib/known-device.ts). The per-IP
     * limit above still applies, and the password is still checked.
     */
    const knownDevice = isKnownDeviceProof(email, parsed.data.knownDevice)

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
    const perAccount = knownDevice ? null : await rateLimit(request, {
      windowMs: 15 * 60 * 1000,
      maxRequests: 10,
      // The key `mobileAccountKey` names, so a right password and a reset can give it back (SCRUM-944 part 1).
      keyGenerator: () => mobileAccountKey(email),
    })
    if (perAccount) return perAccount

    /*
     * The same per-email windows as the dashboard sign-in, counted against the
     * same address. This door verifies staff passwords too (a right one is
     * answered 403, a wrong one 401), so without them it was a password oracle
     * under limits of its own (security review of fix/security-auth, M1).
     */
    const emailKeys = emailKeysFor(email)
    try {
      if (!knownDevice) await refuseOverEmailLimits(emailKeys)
    } catch (error) {
      if (error instanceof Error && error.message === SIGNIN_ACCOUNT_LOCKED) {
        return errorResponse("Too many sign-in attempts. Try again later.", 429, ErrorCode.RATE_LIMITED)
      }
      throw error
    }

    // Find user
    const user = await db.user.findUnique({
      where: { email },
      include: {
        profile: true,
      },
    })

    // Always a comparison, so an unknown address takes as long as a known one.
    const isValidPassword = await bcrypt.compare(password, user?.password ?? DUMMY_HASH)
    if (!user?.password || !isValidPassword) {
      return unauthorizedResponse("Invalid email or password")
    }
    // Only wrong passwords stay counted, in both windows (SCRUM-944 part 1, owner row A-18).
    // A known device took no slot in either window, so it gives none back.
    if (!knownDevice) await Promise.all([settleSigninSuccess(emailKeys), releaseMobileAccountAttempt(email)])

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
    if (blocked === "suspended" || blocked === "staff") return accountRefusal(blocked)
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
      // Kept by the app and sent with its next sign-in to this account (`knownDevice` above). Null without a secret.
      knownDevice: knownDeviceCookie(user.email)?.value ?? null,
    })
  } catch (error) {
    logger.error("Signin error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to sign in")
  }
}
