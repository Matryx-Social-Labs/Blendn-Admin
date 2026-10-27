import { logger } from "@/lib/logger"
import { refRoomBanRefusal } from "@/lib/room-ban"
import { distinctEventsAttended } from "@/lib/attendee-counts"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockedEitherWay, conversationPair } from "@/lib/conversations"
import { mayShowRealName } from "@/lib/conversation-identity"
import { roomPseudonymOf } from "@/lib/anonymous-names"
import { friendOfferFor } from "@/lib/friend-offer"
import { profileBadges } from "@/lib/profile-badges"
import { identityForRef, nonEventRoomCard } from "@/lib/identity"
import { savedCount } from "@/lib/saved-events"
import { ageFrom } from "@/lib/age"
import { homeStateLabel, languageLabels, signLabel } from "@/lib/about-you"
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
    // Banned from the room this handle came from: the chat's answer (`refRoomBanRefusal`).
    const banned = await refRoomBanRefusal(ref, authUser.userId)
    if (banned) return banned
    /*
     * Who the ref names, and whether the viewer may see who that is. A room
     * handle is answered in its own room's terms — see `IdentityScope` for the
     * staging case where a reveal at one event named somebody through the
     * pseudonym they kept at another.
     */
    /*
     * A crew's, Blend's or board post's handle is a room card, not an identity
     * (SCRUM-864): it names its person only to somebody that room admits.
     */
    const card = await nonEventRoomCard(authUser.userId, ref)
    const { userId, room, identified } = card
      ? { userId: card.userId, room: null, identified: false }
      : await identityForRef(authUser.userId, ref)
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
            languages: true,
            home_state: true,
            sun_sign: true,
            sign_system: true,
            show_badges: true,
            shows_up_badge: true,
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
     * `identityForRef` is the gate: by raw id, in a conversation that names
     * them (a match counts once THEY have revealed to you: SCRUM-752), or they
     * chose to be public in a room you were in; by a room handle, only
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
    if (card || (room && !identified)) {
      return successResponse({
        id: ref,
        name: card ? card.name : await roomPseudonymOf(room!, userId),
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
            // Tier B (plan v2 §8.5): the whole set only once they are known to you.
            languages: languageLabels(user.profile?.languages),
            homeState: homeStateLabel(user.profile?.home_state),
            sign: signLabel(user.profile?.sun_sign, user.profile?.sign_system),
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
      /*
       * The whole list only to somebody who may see who this is: it is the same
       * in every room, so a card that withholds the name withholds it too. The
       * key stays, empty, for clients that read it (SCRUM-835).
       */
      interests: identified ? user.user_interests.map((ui) => ui.category) : [],
      memberSince: user.createdAt,
      stats: {
        // Your own count includes the places you went live at, as your list
        // does; anybody else's view of you counts events only.
        eventsAttended: await distinctEventsAttended(user.id, { places: isOwnProfile }),
        eventsFavorited: user._count.event_favorites,
        eventsOrganized: user._count.organized_events,
        // What your own saved list holds (its filter, not every row ever saved); yours alone.
        ...(isOwnProfile && { savedCount: await savedCount(user.id) }),
      },
      isOwnProfile,
      identityVisible: identified,
      // The interests you have in common, by name, for the outlined chips (SCRUM-858).
      ...(identified && !isOwnProfile && { sharedInterests: await sharedInterestNames(authUser.userId, user.user_interests) }),
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
      // The same offer, under the same rule, as `GET /profiles/:id`: only for
      // somebody else you may see, so the app needs no second read.
      ...(identified && !isOwnProfile && { friend: await friendOfferFor(authUser.userId, userId) }),
      // Badges, under the rule `GET /profiles/:id` applies: the person shows them
      // (`show_badges`, on unless turned off) and the viewer may see who they are.
      // Earned from check-ins and derived here, never stored (lib/profile-badges.ts).
      ...(identified && user.profile && user.profile.show_badges !== false
        ? { badges: await profileBadges(userId, user.profile.shows_up_badge) }
        : {}),
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
 *
 * `youRevealed` / `theyRevealed` are that open conversation's, exactly as
 * `GET /conversations/:id` sends them (`theyRevealed` is `mayShowRealName`,
 * so a never-pseudonymous conversation reads true), so the profile's
 * one-sided copy and the thread agree. Both false with no open conversation.
 * Only ever sent where `connection` is: to a viewer who may already see who
 * this is.
 */
async function connectionBetween(
  viewerId: string,
  otherId: string
): Promise<{ conversationId: string | null; request: "sent" | "received" | null; youRevealed: boolean; theyRevealed: boolean }> {
  if (viewerId === otherId) return { conversationId: null, request: null, youRevealed: false, theyRevealed: false }
  const [user1_id, user2_id] = conversationPair(viewerId, otherId)
  const [conversation, pending] = await Promise.all([
    db.private_conversations.findUnique({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      select: {
        id: true,
        closed_at: true,
        user1_id: true,
        user2_id: true,
        user1_pseudonym: true,
        user2_pseudonym: true,
        user1_revealed: true,
        user2_revealed: true,
      },
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
  const open = conversation && !conversation.closed_at ? conversation : null
  return {
    conversationId: open?.id ?? null,
    request: pending ? (pending.sender_id === viewerId ? "sent" : "received") : null,
    youRevealed: open ? (open.user1_id === viewerId ? open.user1_revealed : open.user2_revealed) : false,
    theyRevealed: open ? mayShowRealName(open, otherId) : false,
  }
}

/** The names, out of `theirs`, the viewer has picked too. */
async function sharedInterestNames(viewerId: string, theirs: { category: { id: string; name: string } }[]): Promise<string[]> {
  if (theirs.length === 0) return []
  const mine = await db.user_interests.findMany({
    where: { user_id: viewerId, category_id: { in: theirs.map((t) => t.category.id) } },
    select: { category_id: true },
  })
  const shared = new Set(mine.map((m) => m.category_id))
  return theirs.filter((t) => shared.has(t.category.id)).map((t) => t.category.name)
}
