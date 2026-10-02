import { logger } from "@/lib/logger"
import { distinctEventsAttended } from "@/lib/attendee-counts"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockedEitherWay, conversationPair } from "@/lib/conversations"
import { roomPseudonymOf } from "@/lib/anonymous-names"
import { identityForRef } from "@/lib/identity"
import { ageFrom } from "@/lib/age"
import { db } from "@/lib/db"
import { normalizeLocationToCity } from "@/lib/location"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { SYSTEM_USER_ID } from "@/lib/event-kind"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    /*
     * `ref` is a room handle or a raw id (SCRUM-371). Everything below acts on
     * the real id; only the echo in `id` uses the ref, so a handle never comes
     * back as the id it stands for.
     */
    const { userId: ref } = await params
    /*
     * Who the ref names, and whether the viewer may see who that is. A room
     * handle is answered in its own room's terms — see `IdentityScope` for the
     * staging case where a reveal at one event named somebody through the
     * pseudonym they kept at another.
     */
    const { userId, room, identified } = await identityForRef(authUser.userId, ref)
    // The owner of every venue day is not a person anyone can look at; its
    // "events organised" would be a count of every venue day ever made.
    if (userId === SYSTEM_USER_ID) return notFoundResponse("User not found")

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
            work_field: true,
            blur_photo: true,
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
     * Every room surface returned the real user id -- the roster, the chat
     * participant list, message authors, reactions -- because the client needs
     * it to block, report and open a message request. Any of those ids could be
     * handed straight to this route, which returned the real name and photos to
     * anyone holding a valid token. Two requests turned a whole room's
     * pseudonyms into named faces. (They carry room handles now, SCRUM-371 —
     * this gate is what stops a handle being worth more than the room says.)
     *
     * `identityForRef` is the gate: by raw id, matched, in a conversation, or
     * they chose to be public in a room you were in; by a room handle, only
     * what that room shows (handled above). Co-presence alone is deliberately not
     * enough -- sharing a room is what lets you send a request, not consent to
     * be identified.
     */
    const isOwnProfile = authUser.userId === userId

    /*
     * A room card, for somebody that room keeps anonymous: exactly what the
     * roster already shows beside their pseudonym, and nothing else.
     *
     * Their pseudonym in that room rather than "Attendee" — the card that
     * opened this already shows it, so it discloses nothing, and a second
     * name for one person in one room is how surfaces start to disagree.
     * Age and city stay, as they do on the roster (owner decision, #485).
     * Everything that is the same in every room goes: the interest list,
     * the join date and the attendance counts are a fingerprint, and a
     * viewer who has seen this person named elsewhere could match them to
     * the pseudonym field by field.
     */
    if (room && !identified) {
      return successResponse({
        id: ref,
        name: await roomPseudonymOf(room, userId),
        age: ageFrom(user.profile),
        location: await normalizeLocationToCity(user.profile?.location),
        isOwnProfile: false,
        identityVisible: false,
      })
    }

    const publicProfile = {
      // The ref as given — a handle in, the same handle out — except for your
      // own profile, whose real id is yours to have.
      id: isOwnProfile ? user.id : ref,
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
      /*
       * Outside the gate, as on `/profiles/:id`: "works in design" is an
       * attribute, not an address. The app reads it for the card's subtitle
       * and this route never sent it (SCRUM-458).
       */
      work_field: user.profile?.work_field ?? null,
      ...(identified
        ? {
            image: user.image,
            photos,
            bio: user.profile?.bio || null,
            occupation: user.profile?.occupation || null,
            education: user.profile?.education || null,
          }
        : {
            /*
             * The blurred photo for someone who may not see the real one: a
             * stored derivative, never the real URL (see `/profiles/:id`). The
             * app drew no photo at all here, since this route never sent it.
             */
            blurPhoto: user.profile?.blur_photo ?? null,
          }),
      // Derived — see `ageFrom` in lib/age.ts. The date itself is read here and
      // never returned; this response is an explicit field list, not a spread.
      age: ageFrom(user.profile),
      location: await normalizeLocationToCity(user.profile?.location),
      interests: user.user_interests.map((ui) => ui.category),
      memberSince: user.createdAt,
      stats: {
        // Your own count includes the places you went live at, as your list
        // does; anybody else's view of you counts events only.
        eventsAttended: await distinctEventsAttended(user.id, { places: isOwnProfile }),
        eventsFavorited: user._count.event_favorites,
        eventsOrganized: user._count.organized_events,
      },
      isOwnProfile,
      identityVisible: identified,
      /*
       * What is already open between you, so a room card can say "Message" or
       * "Request sent" instead of offering a request that would be refused.
       *
       * Only when you may already see who this is. Otherwise it would be the
       * leak `identityVisible` withholds, by another field: a friend's card in
       * a room, with their `friends_see_me_in_rooms` off, reading
       * `conversationId: …` is the friend DM saying which pseudonym is them.
       */
      ...(identified && { connection: await connectionBetween(authUser.userId, userId) }),
    }

    return successResponse(publicProfile)
  } catch (error) {
    logger.error("Get public profile error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get user profile")
  }
}

/**
 * The viewer's open conversation with `otherId`, and any pending message
 * request between them, from the viewer's side. A closed conversation is not
 * one you can open, so it reads as none.
 */
async function connectionBetween(
  viewerId: string,
  otherId: string
): Promise<{ conversationId: string | null; request: "sent" | "received" | null }> {
  if (viewerId === otherId) return { conversationId: null, request: null }
  const [user1_id, user2_id] = conversationPair(viewerId, otherId)
  const [conversation, pending] = await Promise.all([
    db.private_conversations.findUnique({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      select: { id: true, closed_at: true },
    }),
    db.message_requests.findFirst({
      where: {
        status: "pending",
        OR: [
          { sender_id: viewerId, recipient_id: otherId },
          { sender_id: otherId, recipient_id: viewerId },
        ],
      },
      select: { sender_id: true },
    }),
  ])
  return {
    conversationId: conversation && !conversation.closed_at ? conversation.id : null,
    request: pending ? (pending.sender_id === viewerId ? "sent" : "received") : null,
  }
}
