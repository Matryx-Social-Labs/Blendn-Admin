import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { normalizeLocationToCity } from "@/lib/location"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
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

    if (!user || user.deletedAt) {
      return notFoundResponse("User not found")
    }

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
    console.error("Session error:", error)
    return serverErrorResponse("Failed to get session")
  }
}
