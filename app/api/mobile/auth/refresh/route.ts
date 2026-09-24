import { logger } from "@/lib/logger"
import jwt from "jsonwebtoken"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import {
  accountBlockReason,
  refreshTokenOwner,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  STAFF_MESSAGE,
  SUSPENDED_MESSAGE,
} from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { refreshTokenSchema } from "@/lib/validations/auth"
import { rateLimit, createAuthRateLimit } from "@/lib/rate-limit"

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResult = await rateLimit(request, createAuthRateLimit("refresh"))
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
      /*
       * Refused — but say why when the reason is the account, not the token.
       *
       * Suspension revokes every refresh token, so this branch used to answer
       * a suspended person with 401 and the suspended check below was
       * unreachable for exactly the case it exists for: the phone signed
       * them out with "You were signed out" instead of "This account has
       * been suspended" (SCRUM-290). A token we signed and that has not
       * expired names its account; nothing is issued on this path, and a
       * forged or expired token names nobody.
       */
      const ownerId = refreshTokenOwner(oldRefreshToken)
      const owner = ownerId
        ? await db.user.findUnique({
            where: { id: ownerId },
            select: { deletedAt: true, suspended_at: true, role: true },
          })
        : null
      return (owner && refusalFor(accountBlockReason(owner))) || unauthorizedResponse("Invalid or expired refresh token")
    }

    // Check if user still exists
    const user = await db.user.findUnique({
      where: { id: decoded.userId },
    })

    /*
     * The boundary that actually enforces a suspension.
     *
     * Access tokens are 15 minutes and are verified without a database read, so
     * this — plus revoking refresh tokens at the moment of suspension — is what
     * bounds a suspended session's remaining life. Refusing here without
     * rotating means the token they are holding stays revoked-free but useless.
     */
    const blocked = accountBlockReason(user)
    const refusal = refusalFor(blocked)
    if (refusal) return refusal
    // `!user` is already covered by `blocked === "deleted"`; naming it again is
    // what narrows the type for everything below.
    if (blocked || !user) return unauthorizedResponse("User not found")

    // Generate new tokens
    const accessToken = signAccessToken(user.id, user.email)
    const refreshToken = signRefreshToken(user.id, user.email)

    // Store the new one, then retire the old one pointing at it — so a replay
    // of the old token inside the grace window can find and revoke the
    // successor the client never received.
    await storeRefreshToken(user.id, refreshToken)
    await revokeRefreshToken(oldRefreshToken, (jwt.decode(refreshToken) as { jti?: string } | null)?.jti)

    return successResponse({
      accessToken,
      refreshToken,
    })
  } catch (error) {
    logger.error("Token refresh error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to refresh token")
  }
}

/** The 403 that tells a person why their account may not hold a session. */
function refusalFor(reason: ReturnType<typeof accountBlockReason>) {
  if (reason === "suspended") return forbiddenResponse(SUSPENDED_MESSAGE)
  if (reason === "staff") return forbiddenResponse(STAFF_MESSAGE)
  return null
}
