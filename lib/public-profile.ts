import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { ageBand, ageFrom, bandsShown, type AgeBand } from "@/lib/age"
import { homeStateLabel, languageLabels, signLabel } from "@/lib/about-you"
import { distinctEventsAttended, regularsAmong } from "@/lib/attendee-counts"
import { ATTENDED } from "@/lib/counting"
import { firstName } from "@/lib/conversation-identity"
import { normalizeLocationToCity } from "@/lib/location"
import { profileBadges } from "@/lib/profile-badges"
import { savedCount } from "@/lib/saved-events"
import { operatesEvent } from "@/lib/tonight"

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
 * What a room row may say about somebody before they reveal (D-030, SCRUM-1384): a wide age band and a new / regular
 * chip, and nothing else — no exact age, no city, no join date, no counts. In a room of 20, age plus city plus tenure
 * names people. Every room surface takes both from here: the roster (`/matches`), the night's people, `/checkins`,
 * the room card on `/users/:id` and `/profiles/:id`, and your own "See as others do".
 *
 * - `ageBand`: null unless `AGE_BAND_FLOOR` people who ever checked in at this event as attendees share it. That
 *   population is the same for every viewer and every route and only grows, so comparing two routes, or two
 *   viewers, shows nothing one of them does not. Ages are taken at the event's start, so a birthday flips no row.
 *   Null too with no event (a crew's, Blend's or post's room: no population to hide in) and for an unknown age.
 * - `tenure`: "regular" once they came back (2+ distinct real events, `regularsAmong`), else "new". One bit.
 * - Somebody who operates the event gets neither (`operatesEvent`): hosts see totals only. `viewerId` null is your
 *   own card, which that rule does not touch.
 */
export interface RoomPersonFacts {
  ageBand: AgeBand | null
  tenure: "new" | "regular" | null
}

const NO_FACTS: RoomPersonFacts = { ageBand: null, tenure: null }

export async function roomPersonFacts(
  viewerId: string | null,
  eventId: string | null,
  userIds: string[]
): Promise<Map<string, RoomPersonFacts>> {
  if (viewerId && eventId && (await operatesEvent(viewerId, eventId))) return new Map(userIds.map((id) => [id, NO_FACTS]))
  const [bands, regulars] = await Promise.all([eventId ? bandsAt(eventId, userIds) : new Map<string, AgeBand>(), regularsAmong(userIds)])
  return new Map(userIds.map((id) => [id, { ageBand: bands.get(id) ?? null, tenure: regulars.has(id) ? "regular" : "new" }]))
}

/**
 * The bands of these people that the event's attendees share `AGE_BAND_FLOOR` deep: one read, an age histogram of
 * the event (a few dozen rows however big the room) with the asked-for ids beside their age. The SQL age is
 * `ageFrom`'s: the birth date in UTC when it is plausible, else the stored age.
 */
async function bandsAt(eventId: string, userIds: string[]): Promise<Map<string, AgeBand>> {
  if (userIds.length === 0) return new Map()
  const histogram = await db.$queryRaw<{ age: number; people: number; targets: string[] | null }[]>`
    WITH room AS (
      SELECT DISTINCT user_id FROM event_check_ins
       WHERE event_id = ${eventId}::uuid AND kind = 'attendee' AND status::text IN (${Prisma.join(ATTENDED)})
    ), aged AS (
      SELECT r.user_id, COALESCE(CASE WHEN y.years BETWEEN 0 AND 149 THEN y.years END, p.age) AS age
        FROM room r
        JOIN events e ON e.id = ${eventId}::uuid
        LEFT JOIN profiles p ON p.id = r.user_id
        CROSS JOIN LATERAL (
          SELECT date_part('year', age(timezone('UTC', e.start_time)::date, p.date_of_birth))::int AS years
        ) y
    )
    SELECT age, COUNT(*)::int AS people, array_agg(user_id) FILTER (WHERE user_id = ANY(${userIds}::text[])) AS targets
      FROM aged
     WHERE age IS NOT NULL
     GROUP BY age`
  const shown = bandsShown(histogram)
  return new Map(
    histogram.flatMap(({ age, targets }) => {
      const band = ageBand(age)
      return band && shown.has(band) ? (targets ?? []).map((id) => [id, band] as const) : []
    })
  )
}

/**
 * A room card, for somebody that room keeps anonymous: exactly what the roster shows beside their pseudonym
 * (`roomPersonFacts`), and nothing else.
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
