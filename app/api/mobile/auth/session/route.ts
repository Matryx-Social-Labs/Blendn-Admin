import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { profileForSelfResponse } from "@/lib/self-profile"
import { db } from "@/lib/db"
import { accountBlockReason, getAuthenticatedUser, signInMethodOf } from "@/lib/mobile-auth"
import { accountRefusal } from "@/lib/account-refusal"
import { normalizeLocationToCity } from "@/lib/location"
import {
  successResponse,
  unauthorizedResponse,
  ErrorCode,
  errorResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    // Get authenticated user from token
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Fetch full user data
    const user = await db.user.findUnique({
      where: { id: authUser.userId },
      include: {
        profile: true,
        oauth_accounts: { select: { provider: true }, orderBy: { created_at: "desc" } },
      },
    })

    // The app calls this on every cold start, so it is where a suspension the
    // user has not yet been told about surfaces as something other than a
    // screen that silently fails to load.
    const blocked = accountBlockReason(user)
    if (blocked === "suspended" || blocked === "staff") return accountRefusal(blocked)
    // `!user` is already covered by `blocked === "deleted"`; naming it again is
    // what narrows the type for everything below.
    if (blocked || !user) return errorResponse("User not found", 404, ErrorCode.ACCOUNT_DELETED)

    // Return user directly (not wrapped in { user: ... })
    const normalizedLocation = await normalizeLocationToCity(user.profile?.location)

    return successResponse({
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
      // What the account can sign in with, for the one row Settings shows or hides (the Password row).
      signInMethod: signInMethodOf(user),
      profile: user.profile
        ? { ...profileForSelfResponse(user.profile), location: normalizedLocation }
        : null,
    })
  } catch (error) {
    logger.error("Session error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get session")
  }
}
