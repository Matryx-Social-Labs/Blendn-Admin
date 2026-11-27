import type { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { ageFrom } from "@/lib/age"
import { homeStateLabel, languageLabels, signLabel } from "@/lib/about-you"
import { distinctEventsAttended } from "@/lib/attendee-counts"
import { firstName } from "@/lib/conversation-identity"
import { normalizeLocationToCity } from "@/lib/location"
import { profileBadges } from "@/lib/profile-badges"
import type { RoomPersonFacts } from "@/lib/room-person-facts"
import { savedCount } from "@/lib/saved-events"

/**
 * The person card `GET /users/:id` answers, in its two shapes, and the "See as others do" preview
 * (`GET /me/preview`), which must be the same card and not a copy of it: the preview is built here, from the same
 * functions, so a field the room withholds is withheld in the preview too.
 */

export const publicUserSelect = {
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
  user_interests: { select: { category: { select: { id: true, name: true, slug: true, icon: true } } } },
  _count: { select: { event_favorites: true, organized_events: true } },
} as const satisfies Prisma.UserSelect

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>

/**
 * A room card, for somebody that room keeps anonymous: exactly what the roster shows beside their pseudonym
 * (`roomPersonFacts`, lib/room-person-facts.ts), and nothing else.
 *
 * Their pseudonym in that room rather than "Attendee" — the card that opened this already shows it, so it discloses
 * nothing, and a second name for one person in one room is how surfaces start to disagree. `age` and `location` stay
 * as keys, null, for installed builds that read them. Everything that is the same in every room goes: the interest
 * list, the join date and the attendance counts are a fingerprint, and a viewer who has seen this person named
 * elsewhere could match them to the pseudonym field by field.
 *
 * `pseudonym` (SCRUM-1046) is the same name, sent only when it IS a room pseudonym, so the app reads a contract rather
 * than a field: absent for a crew's room (a first name) and for somebody with no pseudonym on record (`name` is then
 * the flat "Attendee").
 */
export function anonymousCard(id: string, room: { name: string; pseudonym: boolean }, facts: RoomPersonFacts) {
  return {
    id,
    name: room.name,
    ...(room.pseudonym && { pseudonym: room.name }),
    age: null,
    location: null,
    ageBand: facts.ageBand,
    tenure: facts.tenure,
    isOwnProfile: false,
    identityVisible: false,
  }
}

/**
 * Everything on the card that depends only on the person and on whether the viewer may see who they are — not on
 * anything between the two (the route adds those: tonight, a wave, the connection, the friend offer, shared
 * interests).
 *
 * `firstNameOnly`: a room handle names its person by first name only (SCRUM-493); a raw id, which a match or a
 * conversation reached, the full name.
 */
export async function personCardBody(
  user: PublicUser,
  opts: { id: string; identified: boolean; askedOnly: boolean; firstNameOnly: boolean; isOwnProfile: boolean }
) {
  const { identified, askedOnly, isOwnProfile } = opts
  const p = user.profile
  // Prefer the profile gallery, fall back to the single account image.
  const photos: string[] = p?.photos && p.photos.length > 0 ? p.photos : user.image ? [user.image] : []
  const fullName = p?.name || user.name
  return {
    // The ref as given — a handle in, the same handle out — except for your own profile, whose real id is yours.
    id: opts.id,
    /*
     * Pseudonyms are per event and this card has no event context, so there is no pseudonym to return -- the client
     * already holds the room's one from the roster. A flat label is honest; inventing a second name here would let two
     * surfaces disagree about who someone is.
     *
     * Withheld fields are **absent**, not null, so a client reading `image` gets undefined rather than a convincing
     * blank. `occupation` and `education` go with the name: "Principal @ Arclight Labs" identifies about as well as a
     * photograph does.
     */
    name: identified ? (opts.firstNameOnly && fullName ? firstName(fullName) : fullName) : "Attendee",
    // Outside the gate, as on `/profiles/:id`: "works in design" is an attribute, not an address (SCRUM-458).
    work_field: p?.work_field ?? null,
    ...(identified
      ? {
          image: user.image,
          photos,
          // Not to somebody only their pending request names: bio and orientation wait for the accept (A-32).
          ...(!askedOnly && { bio: p?.bio || null }),
          occupation: p?.occupation || null,
          education: p?.education || null,
          // Tier B (plan v2 §8.5): the whole set only once they are known to you.
          languages: languageLabels(p?.languages),
          homeState: homeStateLabel(p?.home_state),
          sign: signLabel(p?.sun_sign, p?.sign_system),
        }
      : {
          // The blurred photo for someone who may not see the real one: a stored derivative, never the real URL.
          blurPhoto: p?.blur_photo ?? null,
        }),
    /*
     * Derived — see `ageFrom` in lib/age.ts. The date itself is never returned: this is an explicit field list.
     * Somebody a raw id does not name gets no age, city, join date or counts (D-030), and no band or chip either: a raw
     * id has no room to count a band over, and answering it would make this a lookup on any id. Keys kept, null.
     */
    ...(identified
      ? { age: ageFrom(p), location: await normalizeLocationToCity(p?.location) }
      : { age: null, location: null, ageBand: null, tenure: null }),
    // The whole list only to somebody who may see who this is; the key stays, empty, for clients that read it (SCRUM-827).
    interests: identified ? user.user_interests.map((ui) => ui.category) : [],
    ...(identified && {
      memberSince: user.createdAt,
      stats: {
        // Your own count includes the places you went live at, as your list does; anybody else's counts events only.
        eventsAttended: await distinctEventsAttended(user.id, { places: isOwnProfile }),
        eventsFavorited: user._count.event_favorites,
        eventsOrganized: user._count.organized_events,
        // What your own saved list holds; yours alone.
        ...(isOwnProfile && { savedCount: await savedCount(user.id) }),
      },
    }),
    isOwnProfile,
    identityVisible: identified,
    // Badges when the person shows them (`show_badges`, on unless turned off) and the viewer may see who they are.
    ...(identified && p && p.show_badges !== false ? { badges: await profileBadges(user.id, p.shows_up_badge) } : {}),
  }
}

/** The event room this person joined last and the pseudonym they carry there: what a room calls them. Nulls if none yet. */
export async function latestRoom(userId: string): Promise<{ pseudonym: string | null; eventId: string | null }> {
  const member = await db.chat_group_members.findFirst({
    where: { user_id: userId, anonymous_name: { not: null }, chat_group: { kind: "event" } },
    orderBy: { joined_at: "desc" },
    select: { anonymous_name: true, chat_group: { select: { event_id: true } } },
  })
  return { pseudonym: member?.anonymous_name ?? null, eventId: member?.chat_group.event_id ?? null }
}
