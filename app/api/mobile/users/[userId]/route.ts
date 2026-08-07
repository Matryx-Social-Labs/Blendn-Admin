import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockedEitherWay } from "@/lib/conversations"
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
            bio: true,
            occupation: true,
            education: true,
            interests: true,
            photos: true,
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

    /*
     * The table this comment used to say did not exist has existed for a long
     * time; the check was never written. So someone you blocked could keep
     * reading your profile, which is most of what a block is for.
     *
     * 404 rather than 403: confirming the account exists tells a blocked person
     * they were blocked, and that is information the block is meant to withhold.
     */
    if (await blockedEitherWay(authUser.userId, userId)) {
      return notFoundResponse("User not found")
    }

    // Format the response
    // Build photos array: prefer profile gallery, fall back to single user image
    const photos: string[] = (user.profile?.photos && user.profile.photos.length > 0)
      ? user.profile.photos
      : user.image
        ? [user.image]
        : []

    const publicProfile = {
      id: user.id,
      name: user.profile?.name || user.name,
      image: user.image,
      photos,
      age: user.profile?.age,
      location: await normalizeLocationToCity(user.profile?.location),
      bio: user.profile?.bio || null,
      occupation: user.profile?.occupation || null,
      education: user.profile?.education || null,
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
    logger.error("Get public profile error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get user profile")
  }
}
