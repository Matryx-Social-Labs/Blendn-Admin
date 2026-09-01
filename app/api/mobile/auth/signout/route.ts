import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import {
  getAuthenticatedUser,
  revokeUserRefreshTokens,
  revokeRefreshToken,
} from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"

/**
 * Signing out has to take the push token with it.
 *
 * It did not, and the consequence was the worst defect in the product: a phone
 * kept receiving the previous account's notifications, and those bodies carry
 * verbatim message text. Three things had to fail together and all three did.
 * The client cleared its access token before firing the authenticated DELETE,
 * so that request 401'd. The Settings sign-out never attempted it. And this
 * route revoked refresh tokens and never touched `push_tokens`.
 *
 * The row then simply co-existed with the next user's, because the unique is
 * `(user_id, token)` and not `(token)`. Only uninstalling the app cleared it.
 *
 * Fixing it here rather than only on the client is deliberate: the server is the
 * half that cannot be raced. Whatever the client does with its own storage, by
 * the time this handler returns the row is gone.
 *
 * ```
 *   POST /auth/signout { refreshToken?, pushToken? }
 *          │
 *          ├─ refreshToken given ─> revoke that session  ─> delete THIS device's push token
 *          └─ absent             ─> revoke every session ─> delete EVERY push token
 * ```
 *
 * Signing out everywhere means everywhere. A device still holding a token after
 * "signed out from all devices" is the same bug with a longer name.
 */
export async function POST(request: NextRequest) {
  try {
    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Read the body once. A malformed or absent body is not an error here —
    // it means "sign me out of everything", which is the safe reading.
    let body: { refreshToken?: string; pushToken?: string } = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    let revokedAll = false
    if (body.refreshToken) {
      await revokeRefreshToken(body.refreshToken)
    } else {
      await revokeUserRefreshTokens(authUser.userId)
      revokedAll = true
    }

    /*
     * Scope to one device only when we can actually identify it. Everything
     * else clears every token this user holds.
     *
     * That fallback is deliberate rather than incidental. If the client did not
     * tell us which device it is — an older build, or a request that lost its
     * body — we cannot delete the right row, and the two ways to be wrong are
     * not symmetric. Clearing too much costs somebody a re-registration on
     * their other phone. Clearing too little leaves a stranger receiving their
     * DMs. Fail toward the annoyance.
     *
     * Always scoped by `user_id`, so a device two people share loses only the
     * row belonging to the one leaving. `deleteMany` is idempotent: a second
     * sign-out, or a client that managed its own DELETE first, removes nothing
     * and does not throw.
     */
    const scopeToOneDevice = !revokedAll && Boolean(body.pushToken)
    const { count: pushTokensCleared } = await db.push_tokens.deleteMany({
      where: {
        user_id: authUser.userId,
        ...(scopeToOneDevice ? { token: body.pushToken } : {}),
      },
    })
    logger.info("Push tokens cleared on signout", {
      userId: authUser.userId,
      pushTokensCleared,
      scope: scopeToOneDevice ? "device" : "all",
    })

    auditLog({
      userId: authUser.userId,
      action: revokedAll ? "signout_all" : "signout",
      resource: "auth",
      ipAddress: getRequestIp(request),
    })

    return successResponse({
      message: revokedAll
        ? "Signed out from all devices"
        : "Signed out successfully",
    })
  } catch (error) {
    logger.error("Signout error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to sign out")
  }
}
