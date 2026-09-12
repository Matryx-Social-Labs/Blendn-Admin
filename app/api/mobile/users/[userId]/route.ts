import { logger } from "@/lib/logger"
import { distinctEventsAttended } from "@/lib/attendee-counts"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockedEitherWay } from "@/lib/conversations"
import { maySeeIdentity } from "@/lib/identity"
import { ageFrom } from "@/lib/age"
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
      // A deleted account is nobody to look at. Without this the anonymised
      // row served as a profile — `identityVisible: true`, a member-since
      // date, an attendance count — to anyone who kept the id.
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        image: true,
        createdAt: true,
        profile: {
          select: {
            name: true,
            age: true,
            date_of_birth: true,
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

    /*
     * The room is pseudonymous, and this endpoint was how that came undone.
     *
     * Every room surface returns the real user id -- the roster, the chat
     * participant list, message authors, reactions -- because the client needs
     * it to block, report and open a message request. Any of those ids could be
     * handed straight to this route, which returned the real name and photos to
     * anyone holding a valid token. Two requests turned a whole room's
     * pseudonyms into named faces.
     *
     * `maySeeIdentity` is the gate: matched, in a conversation, or they chose to
     * be public in a room you were in. Co-presence alone is deliberately not
     * enough -- sharing a room is what lets you send a request, not consent to
     * be identified.
     */
    const identified = await maySeeIdentity(authUser.userId, userId)

    const publicProfile = {
      id: user.id,
      /*
       * Pseudonyms are per event and this route has no event context, so there
       * is no pseudonym to return -- the client already holds the room's one
       * from the roster. A flat label is honest; inventing a second name here
       * would let two surfaces disagree about who someone is.
       *
       * Withheld fields are **absent**, not null, so a client reading `image`
       * gets undefined rather than a convincing blank. `occupation` and
       * `education` go with the name: "Principal @ Arclight Labs" identifies
       * about as well as a photograph does.
       */
      name: identified ? user.profile?.name || user.name : "Attendee",
      ...(identified
        ? {
            image: user.image,
            photos,
            bio: user.profile?.bio || null,
            occupation: user.profile?.occupation || null,
            education: user.profile?.education || null,
          }
        : {}),
      // Derived — see `ageFrom` in lib/age.ts. The date itself is read here and
      // never returned; this response is an explicit field list, not a spread.
      age: ageFrom(user.profile),
      location: await normalizeLocationToCity(user.profile?.location),
      interests: user.user_interests.map((ui) => ui.category),
      memberSince: user.createdAt,
      stats: {
        eventsAttended: await distinctEventsAttended(user.id),
        eventsFavorited: user._count.event_favorites,
        eventsOrganized: user._count.organized_events,
      },
      isOwnProfile: authUser.userId === userId,
      identityVisible: identified,
    }

    return successResponse(publicProfile)
  } catch (error) {
    logger.error("Get public profile error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get user profile")
  }
}
