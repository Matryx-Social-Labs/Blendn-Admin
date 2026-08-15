import { Prisma } from "@prisma/client"
import { resolveEventCity } from "@/lib/location"
import { haversineDistance } from "@/lib/geo"

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
  is_featured: true,
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
      check_ins: {
        where: { status: "checked_in" },
      },
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
}

export async function transformEvent(
  event: EventListItem,
  ctx: TransformContext
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
    city: await resolveEventCity(event.city, event.latitude, event.longitude),
    state: event.state,
    country: event.country,
    latitude: event.latitude,
    longitude: event.longitude,
    status: event.status,
    isFeatured: event.is_featured,
    organizer: event.organizer,
    categories: event.categories.map((c) => c.category),
    media: event.media,
    checkInCount: event._count.check_ins,
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
  return Promise.all(events.map((event) => transformEvent(event, ctx)))
}
