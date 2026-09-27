import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { ageFrom } from "@/lib/age"
import { blockedEitherWay, conversationPair } from "@/lib/conversations"
import { normalizeLocationToCity } from "@/lib/location"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { UNNAMED } from "@/lib/conversation-identity"
import { unfriend } from "@/lib/friends"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

type RouteParams = { params: Promise<{ userId: string }> }

/**
 * GET /api/mobile/friends/:userId — a friend's profile.
 *
 * The identified profile, because this person accepted (or asked). It is a
 * separate route from `GET /users/:id` on purpose: that one is what a room
 * card opens, and a friend there is still a pseudonym unless they chose
 * otherwise (`profiles.friends_see_me_in_rooms`). Answering both questions from
 * one route would make the room show what only the friends list should.
 *
 * 404 for anybody who is not a friend, whether or not the account exists.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId
    const { userId } = await params

    const [user1_id, user2_id] = conversationPair(me, userId)
    const [friendship, blocked] = await Promise.all([
      db.friendships.findUnique({
        where: { user1_id_user2_id: { user1_id, user2_id } },
        select: { created_at: true },
      }),
      blockedEitherWay(me, userId),
    ])
    // Blocked is checked too, as on the list: see `GET /friends`.
    if (me === userId || !friendship || blocked) return notFoundResponse("Not found")

    const [user, conversation] = await Promise.all([
      db.user.findUnique({
        where: { id: userId, deletedAt: null },
        select: {
          id: true,
          name: true,
          image: true,
          profile: {
            select: {
              name: true,
              age: true,
              date_of_birth: true,
              location: true,
              bio: true,
              occupation: true,
              education: true,
              photos: true,
            },
          },
          user_interests: { select: { category: { select: { id: true, name: true, slug: true, icon: true } } } },
        },
      }),
      db.private_conversations.findUnique({
        where: { user1_id_user2_id: { user1_id, user2_id } },
        select: { id: true, closed_at: true },
      }),
    ])
    if (!user) return notFoundResponse("Not found")

    const p = user.profile
    const photos = p?.photos?.length ? p.photos : user.image ? [user.image] : []

    return successResponse({
      userId: user.id,
      name: p?.name || user.name || UNNAMED,
      photos,
      bio: p?.bio ?? null,
      occupation: p?.occupation ?? null,
      education: p?.education ?? null,
      // Derived — `ageFrom` reads the date; the date itself is never returned.
      age: ageFrom(p),
      location: await normalizeLocationToCity(p?.location),
      interests: user.user_interests.map((ui) => ui.category),
      friendsSince: friendship.created_at,
      // An open DM, so "Message" goes straight to it. A closed one is not
      // offered: leaving a conversation is the pair's own decision.
      conversationId: conversation && !conversation.closed_at ? conversation.id : null,
    })
  } catch (error) {
    logger.error("Get friend error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load friend")
  }
}

/**
 * DELETE /api/mobile/friends/:userId — unfriend. Silent: nobody is told, and
 * any DM is left alone (unfriending is not blocking). Idempotent.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "friend-remove", authUser.userId))
    if (limited) return limited

    const { userId } = await params
    await unfriend(authUser.userId, userId)
    return successResponse({ removed: true })
  } catch (error) {
    logger.error("Unfriend error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to remove friend")
  }
}
