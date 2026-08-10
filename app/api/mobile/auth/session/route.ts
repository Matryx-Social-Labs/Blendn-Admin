import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { accountBlockReason, getAuthenticatedUser, SUSPENDED_MESSAGE } from "@/lib/mobile-auth"
import { normalizeLocationToCity } from "@/lib/location"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
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
      },
    })

    // The app calls this on every cold start, so it is where a suspension the
    // user has not yet been told about surfaces as something other than a
    // screen that silently fails to load.
    const blocked = accountBlockReason(user)
    if (blocked === "suspended") return forbiddenResponse(SUSPENDED_MESSAGE)
    // `!user` is already covered by `blocked === "deleted"`; naming it again is
    // what narrows the type for everything below.
    if (blocked || !user) return notFoundResponse("User not found")

    // Return user directly (not wrapped in { user: ... })
    const normalizedLocation = await normalizeLocationToCity(user.profile?.location)

    return successResponse({
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
      profile: user.profile
        ? {
            ...user.profile,
            location: normalizedLocation,
          }
        : null,
    })
  } catch (error) {
    logger.error("Session error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get session")
  }
}
