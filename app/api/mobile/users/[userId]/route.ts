import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import { normalizeLocationToCity } from "@/lib/location"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const { userId } = await params

    // Get the user's public profile
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        image: true,
        createdAt: true,
        profile: {
          select: {
            name: true,
            age: true,
            location: true,
            interests: true,
          },
        },
        user_interests: {
          select: {
            category: {
              select: {
                id: true,
                name: true,
                slug: true,
                icon: true,
              },
            },
          },
        },
        // Include some stats
        _count: {
          select: {
            event_check_ins: true,
            event_favorites: true,
            organized_events: true,
          },
        },
      },
    })

    if (!user) {
      return notFoundResponse("User not found")
    }

    // Check if the current user has blocked this user or vice versa
    // For now, we'll skip blocking check since the blocked_users table doesn't exist yet
    // This would be implemented in Phase 6

    // Format the response
    const publicProfile = {
      id: user.id,
      name: user.profile?.name || user.name,
      image: user.image,
      age: user.profile?.age,
      location: await normalizeLocationToCity(user.profile?.location),
      interests: user.user_interests.map((ui) => ui.category),
      memberSince: user.createdAt,
      stats: {
        eventsAttended: user._count.event_check_ins,
        eventsFavorited: user._count.event_favorites,
        eventsOrganized: user._count.organized_events,
      },
      isOwnProfile: authUser.userId === userId,
    }

    return successResponse(publicProfile)
  } catch (error) {
    console.error("Get public profile error:", error)
    return serverErrorResponse("Failed to get user profile")
  }
}
