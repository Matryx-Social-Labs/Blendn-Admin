import { Prisma } from "@prisma/client"
import { NextRequest } from "next/server"

import { ageFrom } from "@/lib/age"
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
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

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
      select: { age: true, date_of_birth: true },
    })
    // Derived, never the stored column — see lib/age.ts. A stored age is the
    // number that was true on the day they signed up.
    const viewerAge = ageFrom(viewer)

    /*
     * The events that count, both for `upcomingEventCount` and for `nextEvent`.
     *
     * One object used in both places on purpose. When these were allowed to
     * drift on the events side, a card could say "3 upcoming" and then headline
     * an event that was not one of them.
     */
    const upcomingEventFilter = {
      deleted_at: null,
      status: "published" as const,
      visibility: "public" as const,
      end_time: { gte: new Date() },
      ...(typeof viewerAge === "number"
        ? { OR: [{ min_age: null }, { min_age: { lte: viewerAge } }] }
        : {}),
    }

    const where: Record<string, unknown> = {
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

    if (city) {
      where.city = { equals: city, mode: "insensitive" }
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

    const venueSelect = {
      id: true,
      name: true,
      address: true,
      city: true,
      latitude: true,
      longitude: true,
      capacity: true,
      venue_type: true,
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
        orderBy: { name: "asc" },
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
          if (a.distance === null) return 1
          if (b.distance === null) return -1
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
        orderBy: { name: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      })
      totalCount = await db.venues.count({ where })
    }

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
        // Kilometres, or null when either side has no fix. The client formats
        // it — `formatDistance` there already owns km-versus-miles.
        distance,
        upcomingEventCount: venue._count.events,
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
