import { Prisma } from "@prisma/client"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import { resolveEventCity, geocodeBudget, type GeocodeBudget } from "@/lib/location"
import { haversineDistance } from "@/lib/geo"
import { eventHost } from "@/lib/event-host"
import { appUrl } from "@/lib/email"

export const eventListSelect = {
  id: true,
  slug: true,
  title: true,
  short_description: true,
  cover_image_url: true,
  start_time: true,
  end_time: true,
  timezone: true,
  venue_name: true,
  address: true,
  city: true,
  state: true,
  country: true,
  latitude: true,
  longitude: true,
  status: true,
  // Capacity and the door, so a card can say how full a night is and what the
  // door expects. Neither identifies anybody; both are the organiser's own.
  max_capacity: true,
  current_capacity: true,
  door_policy: true,
  is_featured: true,
  /*
   * `organizer` is the row's CREATOR, which for a curated event is the admin
   * who ran the curation -- so that column alone would ship a founder's real
   * name, avatar and user id to every attendee browsing the city.
   * `lib/event-host.ts` is what answers "who to show".
   *
   * But NOT `...eventHostSelect`, and the reason is a rule this codebase
   * already paid for once.
   *
   * `eventHostSelect` claims `organizer` too, with a narrower `{ name }`. Spread
   * after this one it silently wins and `id`/`image` vanish -- the same
   * collision `broadcastAuthorSelect` hit through `venue`, which is why the
   * rule is "a fragment may not claim a relation another fragment claims".
   * Here `tsc` caught it (TS2783) because both fragments are typed; through a
   * relation it would have been silent.
   *
   * So the columns are named, and the shape below is a strict SUPERSET of
   * `HostSource` -- `{ id, name, image }` satisfies `{ name }` structurally, so
   * `eventHost` still gets everything it needs and nothing is hand-picked away
   * from it.
   */
  curated_at: true,
  claimed_at: true,
  organizer_org: { select: { display_name: true } },
  organizer: {
    select: {
      id: true,
      name: true,
      image: true,
    },
  },
  categories: {
    select: {
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
          icon: true,
          /*
           * The parent, because events are tagged to **leaves**.
           *
           * An event is "Classical and Carnatic", never "Music". Without the
           * parent, a client that wants "everything musical" has to guess from
           * the leaf's name — which is exactly what the app's "Best Parties"
           * section was doing, matching the substrings `party|night|club|music`
           * and therefore filing Classical and Carnatic as a party.
           *
           * One extra join on a select that was already loading the category.
           * The alternative is the client fetching the whole taxonomy and
           * building its own leaf→parent map, which is a second request and a
           * second copy of the tree to keep in step.
           */
          parent: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      },
    },
  },
  media: {
    select: {
      id: true,
      url: true,
      thumbnail_url: true,
      type: true,
      order: true,
    },
    orderBy: { order: "asc" },
    take: 5,
  },
  _count: {
    select: {
      favorites: true,
      ratings: true,
    },
  },
} satisfies Prisma.eventsSelect

export type EventListItem = Prisma.eventsGetPayload<{
  select: typeof eventListSelect
}>

interface TransformContext {
  favoriteEventIds: Set<string>
  userCheckinMap?: Record<
    string,
    { status: string; checkInId?: string; checkInTime?: Date | null }
  >
  userLat?: number
  userLon?: number
  includeCheckins?: boolean
  /**
   * How many reverse-geocodes this request may still make.
   *
   * Owned by `transformEvents`, not by the caller: a page of null-city rows used
   * to fan out one Nominatim request per event, concurrently, on a user-facing
   * read. City is resolved at write time now, so this only ever covers rows
   * created before that -- and past the budget a card renders without a city
   * rather than the page waiting on a public API.
   */
  geocodes?: GeocodeBudget
}

/*
 * Private, and takes `attended` rather than reading it off `_count`, so a new
 * caller cannot construct a list without answering "how many people" first.
 * `transformEvents` below is the only door in.
 */
async function transformEvent(
  event: EventListItem,
  ctx: TransformContext,
  attended: Map<string, number>
) {
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    shortDescription: event.short_description,
    coverImageUrl: event.cover_image_url,
    startTime: event.start_time,
    endTime: event.end_time,
    timezone: event.timezone,
    venueName: event.venue_name,
    address: event.address,
    city: await resolveEventCity(event.city, event.latitude, event.longitude, ctx.geocodes),
    state: event.state,
    country: event.country,
    latitude: event.latitude,
    longitude: event.longitude,
    status: event.status,
    /*
     * Capacity, so a card can say how full an event is.
     *
     * The list payload carried neither number, so the feed could not tell a
     * nearly-full event from an empty one — and the design's scarcity pill had
     * to be faked from something else or dropped. Both are the organiser's own
     * figures and neither identifies anybody.
     */
    maxCapacity: event.max_capacity,
    /*
     * The real count, not the stored column.
     *
     * `events.current_capacity` has NO WRITER anywhere in the codebase, so this
     * served whatever the row was seeded with — for every event, for ever —
     * beside `checkInCount` on the same object, which is correct. Two fields,
     * one question, and the wrong one was the one named like the answer.
     *
     * Kept as a field rather than removed: an older client build may read it,
     * and a shipped app is not something this repo can update. Serving the true
     * number is strictly better than serving a stale one and cannot break a
     * caller that was already handling an integer.
     */
    currentCapacity: attended.get(event.id) ?? 0,
    /*
     * The organiser's description of the door — "GUEST LIST ONLY" and the
     * like. Informational: nothing here gates an RSVP, exactly as with
     * `min_age`, and the client must not imply otherwise. `open` for almost
     * every event, and the client draws remaining capacity instead.
     */
    doorPolicy: event.door_policy,
    isFeatured: event.is_featured,
    /*
     * Resolved, never passed through.
     *
     * `eventHost` answers org -> platform -> creating user, and the platform
     * branch is the one that matters: a curated event has an admin in
     * `organizer_id` and must never show them. The response SHAPE is unchanged
     * -- `EventDetailScreen.tsx:258` reads `d.organizer?.name || ''` and
     * `:283` reads `d.organizer?.id`, both optional-chained -- so this needs no
     * client release, which is what makes it shippable ahead of one.
     */
    organizer: (() => {
      const host = eventHost(event)
      return host.isPlatform
        ? { id: null, name: host.name, image: null }
        : { id: event.organizer.id, name: host.name, image: event.organizer.image }
    })(),
    /*
     * How the real organiser ever finds out.
     *
     * A curated event shows "Blendn" as its host, which is honest and also a
     * dead end -- the eng review's finding was that the claim funnel had an
     * admin queue and no entry at all. This is the entry: a public,
     * session-free URL the client can put behind "Is this your event?".
     *
     * Null the moment somebody claims it, so the affordance disappears with
     * the thing it was for rather than needing a second flag to hide it.
     */
    claimUrl: event.curated_at && !event.claimed_at ? `${appUrl()}/claim/${event.id}` : null,
    categories: event.categories.map((c) => c.category),
    media: event.media,
    checkInCount: attended.get(event.id) ?? 0,
    favoriteCount: event._count.favorites,
    ratingCount: event._count.ratings,
    isFavorited: ctx.favoriteEventIds.has(event.id),
    userCheckin: ctx.includeCheckins
      ? ctx.userCheckinMap?.[event.id] || { status: "none" }
      : undefined,
    /*
     * `interestedPreview` is deliberately gone. It returned `user.image` — real
     * photographs — for everyone who had favourited an event, to any
     * authenticated caller who asked, with no identity gate of any kind.
     *
     * Favouriting is a private act. Unlike the roster it has no check-in, no
     * pseudonym and no reveal, so nobody who used it ever consented to being
     * shown. And it was harvestable by topic: favourite an event, ask for the
     * preview, collect faces of everybody else interested in that category.
     *
     * `favoriteCount` above is the social proof the feature actually needed.
     */
    distance:
      ctx.userLat !== undefined &&
      ctx.userLon !== undefined &&
      event.latitude &&
      event.longitude
        ? haversineDistance(ctx.userLat, ctx.userLon, event.latitude, event.longitude)
        : null,
  }
}

export async function transformEvents(
  events: EventListItem[],
  ctx: TransformContext
) {
  /*
   * `checkInCount` was `_count.check_ins` filtered to `status: "checked_in"`,
   * which was wrong twice over. `_count` has no DISTINCT and the table holds
   * one row per person **per day**, so a three-day event read three times high
   * — and filtering to `checked_in` alone meant the number went *down* as the
   * night went on and people checked out. The headline count on the feed fell
   * while the event was at its busiest.
   */
  const attended = await distinctAttendeeCounts(events.map((e) => e.id))
  // One budget for the page, made here so it cannot be shared between requests.
  const withBudget = { ...ctx, geocodes: ctx.geocodes ?? geocodeBudget() }
  return Promise.all(events.map((event) => transformEvent(event, withBudget, attended)))
}
