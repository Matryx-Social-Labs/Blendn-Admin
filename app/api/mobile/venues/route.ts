import { Prisma } from "@prisma/client"
import { NextRequest } from "next/server"

import { ageFrom, isAdult, mayParticipate } from "@/lib/age"
import {
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { db } from "@/lib/db"
import { getBoundingBox, haversineDistance } from "@/lib/geo"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { venueQuerySchema } from "@/lib/validations/venue"
import { venueTypeLabel } from "@/lib/venue-types"
import { likeLiteral } from "@/lib/like-literal"
import { cityKey } from "@/lib/address"
import { realEventsWhere } from "@/lib/event-kind"
import { liveGuestIds, venueLiveBucket } from "@/lib/live-count"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { mayAttendWhere, undisputedLinkWhere, venuesTakenOver } from "@/lib/venue-visibility"

/**
 * The most venues a distance sort will pull into memory at once.
 *
 * Same shape and the same reasoning as `DISTANCE_SORT_CEILING` in the events
 * route: this bounds what gets *sorted*, not what gets returned, and it is
 * sized to be unreachable and to say so in the log if it ever is not.
 */
const DISTANCE_SORT_CEILING = 5000

/**
 * Hotspots — the venue-shaped twin of The Pulse.
 *
 * ## Why a venue list is not just an event list grouped by place
 *
 * The Pulse answers "what is on"; this answers "where is worth going". They
 * rank differently and they survive an empty week differently: a venue with
 * nothing on this month is still a real place with a real address, whereas an
 * event that has ended is gone. So this reads `venues` directly rather than
 * deriving places from the event feed.
 *
 * ## What a venue borrows from its events, and why
 *
 * `venues` has no image column. Rather than ship a wall of grey cards or invent
 * a placeholder, each venue carries its **next public event** — which supplies
 * the card image, and doubles as the reason to tap. A venue with nothing
 * upcoming returns `nextEvent: null` and the client draws the typed fallback;
 * no card claims something is happening when nothing is.
 *
 * ## The age gate applies here too
 *
 * `nextEvent` is a real event surfaced to a real viewer, so it passes the same
 * `min_age` filter the events feed applies — otherwise the 18+ event that the
 * feed correctly hides from a sixteen-year-old reappears, with its title and
 * cover art, as the headline of a venue card. Discovery is not the door, but it
 * must not advertise a room the door will turn you away from.
 *
 * As in the events feed, an **unknown** age hides nothing: most OAuth accounts
 * are created without one, and failing closed would empty the screen to punish
 * a missing field.
 *
 * ## A venue an event has taken over is not listed
 *
 * From an hour before a real event at it starts until that event ends, the
 * place is the event's (plan v2 step 2): Places leaves the venue out, and the
 * event's own card says "at <Venue>" instead. The rule is step 4's, written
 * once in `lib/venue-visibility.ts` — the same one that refuses Go Live there
 * with `EVENT_LIVE_HERE` — so the list, the venue page and the door cannot
 * disagree. Per viewer: a 21+ night does not hide its venue from somebody it
 * would turn away (D-3).
 *
 * ## `liveNow` is a bucket, never a number
 *
 * How many guests are live at each venue, exactly as the venue page says it
 * (`lib/live-count.ts`): a bucket, steady for a minute, slow to fall, never
 * counting the caller (D-19, F14). And only to somebody the venue page would
 * answer — onboarded and a known adult; anyone else gets `null`.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }
    // Every row carries a live count; the venue page's limit, for the same reason.
    const limited = await rateLimit(request, userLimit("read", "venues", authUser.userId))
    if (limited) return limited

    const parsed = venueQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { page, limit, search, city, lat, lon, radius, venueType, sortBy, sortOrder } =
      parsed.data

    const viewer = await db.profiles.findUnique({
      where: { id: authUser.userId },
      select: { age: true, date_of_birth: true, onboarded: true },
    })
    // Derived, never the stored column — see lib/age.ts. A stored age is the
    // number that was true on the day they signed up.
    const viewerAge = ageFrom(viewer)
    // Who is live where is told to the people who may go live there: the venue
    // page's own gate (`personAtTheDoor` with no event). Everyone else gets null.
    const mayCountLive = mayParticipate(viewer) && isAdult(viewerAge)

    /*
     * The events that count, both for `upcomingEventCount` and for `nextEvent`.
     *
     * One object used in both places on purpose. When these were allowed to
     * drift on the events side, a card could say "3 upcoming" and then headline
     * an event that was not one of them.
     */
    const now = new Date()
    const upcomingEventFilter = {
      deleted_at: null,
      // A venue's own live room is not an event at it: counted, it would make
      // every venue anyone went live at read "1 upcoming" (F3).
      ...realEventsWhere,
      status: "published" as const,
      visibility: "public" as const,
      end_time: { gte: now },
      /*
       * Two ORs, so under `AND` (F4), and both from lib/venue-visibility.ts,
       * where the takeover reads them. A link the venue's owner disputed is the
       * owner saying the event is not here, so it is no headline here either.
       */
      AND: [undisputedLinkWhere, ...(typeof viewerAge === "number" ? [mayAttendWhere(viewerAge)] : [])],
    }

    const where: Prisma.venuesWhereInput = {
      deleted_at: null,
      // `archived` is how a venue is retired without deleting the events that
      // happened in it, so it must not appear in discovery.
      status: "active",
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { address: { contains: search, mode: "insensitive" } },
        { city: { contains: search, mode: "insensitive" } },
      ]
    }

    // Trimmed like the events filter, so the two agree on what a city is.
    const cityScope = cityKey(city)
    if (cityScope) {
      where.city = { equals: likeLiteral(cityScope), mode: "insensitive" }
    }

    if (venueType) {
      where.venue_type = venueType
    }

    // A bounding box only when the caller asked for one. Sending coordinates
    // means "sort by distance"; it must never silently mean "and hide anything
    // further than N km", which is the bug that blanked the events feed.
    if (lat !== undefined && lon !== undefined && radius !== undefined) {
      const bbox = getBoundingBox(lat, lon, radius)
      where.latitude = { gte: bbox.minLat, lte: bbox.maxLat }
      where.longitude = { gte: bbox.minLon, lte: bbox.maxLon }
    }

    // Last, so it is asked of exactly the venues the filters above chose.
    const taken = await venuesTakenOver(now, where, { viewerAge })
    if (taken.length > 0) where.id = { notIn: taken }

    const venueSelect = {
      id: true,
      name: true,
      address: true,
      city: true,
      latitude: true,
      longitude: true,
      capacity: true,
      venue_type: true,
      floors: true,
      _count: { select: { events: { where: upcomingEventFilter } } },
      events: {
        where: upcomingEventFilter,
        orderBy: { start_time: "asc" },
        take: 1,
        select: {
          id: true,
          title: true,
          slug: true,
          cover_image_url: true,
          start_time: true,
          end_time: true,
        },
      },
    } satisfies Prisma.venuesSelect

    type VenueRow = Prisma.venuesGetPayload<{ select: typeof venueSelect }>

    const shouldSortByDistance =
      sortBy === "distance" && lat !== undefined && lon !== undefined

    let venues: VenueRow[]
    let totalCount: number

    if (shouldSortByDistance) {
      /*
       * Three columns for every candidate, sorted in memory, then the full
       * select for one page — the same two-step the events route uses, for the
       * same reason: the relation count and the nested next-event are far too
       * expensive to fetch for rows that will be thrown away.
       */
      const lightweight = await db.venues.findMany({
        where,
        select: { id: true, latitude: true, longitude: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: DISTANCE_SORT_CEILING,
      })

      if (lightweight.length === DISTANCE_SORT_CEILING) {
        logger.warn("Venue distance sort hit its ceiling; results are truncated", {
          ceiling: DISTANCE_SORT_CEILING,
          city: city ?? null,
        })
      }

      const withDistance = lightweight
        .map((v) => ({
          id: v.id,
          distance:
            v.latitude !== null && v.longitude !== null
              ? haversineDistance(lat, lon, v.latitude, v.longitude)
              : null,
        }))
        .filter((v) => radius === undefined || v.distance === null || v.distance <= radius)
        // Venues with no coordinates sort last in both directions. They are not
        // "infinitely far"; they are unknown, and burying them under a `desc`
        // sort would put the least informative rows first.
        .sort((a, b) => {
          if (a.distance === null || b.distance === null) {
            if (a.distance === b.distance) return a.id < b.id ? -1 : 1
            return a.distance === null ? 1 : -1
          }
          // Ties by id, so equal distances keep one order from page to page.
          if (a.distance === b.distance) return a.id < b.id ? -1 : 1
          return sortOrder === "asc" ? a.distance - b.distance : b.distance - a.distance
        })

      totalCount = withDistance.length
      const pageIds = withDistance.slice((page - 1) * limit, page * limit).map((v) => v.id)

      const pageVenues = await db.venues.findMany({
        where: { id: { in: pageIds } },
        select: venueSelect,
      })
      // `findMany` with `in` does not preserve the order of the list.
      const byId = new Map(pageVenues.map((v) => [v.id, v]))
      venues = pageIds.map((id) => byId.get(id)).filter((v): v is VenueRow => Boolean(v))
    } else {
      venues = await db.venues.findMany({
        where,
        select: venueSelect,
        // `id` after the name: two venues with one name keep one order, so a page
        // boundary between them never repeats or skips one.
        orderBy: [{ name: sortOrder }, { id: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      })
      totalCount = await db.venues.count({ where })
    }

    const liveNow = mayCountLive ? await liveBuckets(venues.map((v) => v.id), authUser.userId, now) : null

    const items = venues.map((venue) => {
      const next = venue.events[0]
      const distance =
        lat !== undefined &&
        lon !== undefined &&
        venue.latitude !== null &&
        venue.longitude !== null
          ? haversineDistance(lat, lon, venue.latitude, venue.longitude)
          : null

      return {
        id: venue.id,
        name: venue.name,
        address: venue.address,
        city: venue.city,
        latitude: venue.latitude,
        longitude: venue.longitude,
        capacity: venue.capacity,
        venueType: venue.venue_type,
        // The label the dashboard already shows, so the app never ships a
        // second copy of the vocabulary and never renders a raw `pub_bar`.
        venueTypeLabel: venueTypeLabel(venue.venue_type),
        // The 3D map's height override: floors × 3.66 m (lib/venue-floors.ts). Null: the map's own.
        floors: venue.floors,
        // Kilometres, or null when either side has no fix. The client formats
        // it — `formatDistance` there already owns km-versus-miles.
        distance,
        upcomingEventCount: venue._count.events,
        liveNow: liveNow ? (liveNow.get(venue.id) ?? "quiet") : null,
        nextEvent: next
          ? {
              id: next.id,
              title: next.title,
              slug: next.slug,
              coverImageUrl: next.cover_image_url,
              startTime: next.start_time,
              endTime: next.end_time,
            }
          : null,
      }
    })

    return successResponse({
      venues: items,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
    })
  } catch (error) {
    logger.error("List venues error", { error: String(error) })
    return serverErrorResponse("Failed to list venues")
  }
}

/**
 * `liveNow` for a page of venues, as `GET /venues/:id` reads it for one: the
 * same `liveGuestIds` (one read for the page, never one per venue — HM-I05)
 * and the same per-venue minute cache (`venueLiveBucket`), the caller left
 * out only if counted.
 */
async function liveBuckets(venueIds: string[], viewerId: string, now: Date) {
  const live = await liveGuestIds(venueIds, now)
  const buckets = await Promise.all(
    venueIds.map((id) => venueLiveBucket(id, viewerId, async () => live.get(id) ?? new Set<string>(), now.getTime()))
  )
  return new Map(venueIds.map((id, i) => [id, buckets[i]]))
}
