import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { ageFrom } from "@/lib/age"
import { blockedEitherWay, conversationPair } from "@/lib/conversations"
import { normalizeLocationToCity } from "@/lib/location"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { UNNAMED } from "@/lib/conversation-identity"
import { holdingPair, matchSelect, unfriend } from "@/lib/friends"
import { userIdFromRefIfIdentified } from "@/lib/identity"
import { homeStateLabel, languageLabels, signLabel } from "@/lib/about-you"
import { expertiseLabels } from "@/lib/expertise"
import { profileBadges } from "@/lib/profile-badges"
import { sharedInterestNames } from "@/lib/shared-interests"
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
    // A friend's id, or a room handle for a friend you can recognise there.
    // Any other handle reads as a stranger's 404 — see the helper (SCRUM-371).
    const userId = await userIdFromRefIfIdentified(me, (await params).userId)

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
              // The about line and badges, as `GET /users/:id` reads them for somebody you may see.
              work_field: true,
              expertise: true,
              languages: true,
              home_state: true,
              sun_sign: true,
              sign_system: true,
              show_badges: true,
              shows_up_badge: true,
            },
          },
          user_interests: { select: { category: { select: { id: true, name: true, slug: true, icon: true } } } },
        },
      }),
      db.private_conversations.findUnique({
        where: { user1_id_user2_id: { user1_id, user2_id } },
        select: { id: true, ...matchSelect },
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
      // The ones you hold too, as `GET /users/:id` sends them: one person, one page from both doors (SCRUM-896).
      sharedInterests: await sharedInterestNames(me, user.user_interests),
      /*
       * The about line, as `GET /users/:id` sends it to somebody who may see
       * who this is (a friend always may): the field of work and expertise
       * (labels), and the Tier B set (plan v2 §8.5) a card keeps back until then.
       */
      work_field: p?.work_field ?? null,
      expertise: expertiseLabels(p?.expertise),
      languages: languageLabels(p?.languages),
      homeState: homeStateLabel(p?.home_state),
      sign: signLabel(p?.sun_sign, p?.sign_system),
      // Badges under the profile's rule: shown unless they turned them off (`show_badges`). Derived, never stored.
      ...(p && p.show_badges !== false ? { badges: await profileBadges(user.id, p.shows_up_badge) } : {}),
      friendsSince: friendship.created_at,
      // An open DM, so "Message" goes straight to it. A closed one is not
      // offered: leaving a conversation is the pair's own decision. Nor is one
      // that is still a pseudonym ("Heron") to either of you: this card names
      // the person, and the DM beside it must not tie the two together.
      conversationId: conversation && !conversation.closed_at && !holdingPair(conversation) ? conversation.id : null,
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

    const userId = await userIdFromRefIfIdentified(authUser.userId, (await params).userId)
    await unfriend(authUser.userId, userId)
    return successResponse({ removed: true })
  } catch (error) {
    logger.error("Unfriend error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to remove friend")
  }
}
