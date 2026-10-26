import type { Prisma } from "@prisma/client"
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
import { cityKey } from "@/lib/address"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { venuesTakenOver } from "@/lib/venue-visibility"
import { paginationMeta } from "@/lib/pagination"
import {
  listedVenuesWhere,
  liveBuckets,
  liveVenueIds,
  openTonightVenueIds,
  upcomingEventsWhere,
  venueTier,
} from "@/lib/venue-listing"
import { tonightHours } from "@/lib/venue-tonight"
import { DISTANCE_SORT_CEILING, distanceCandidates } from "@/lib/venue-distance"

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
 * ## A claimed venue its owner took off Blendn is not listed
 *
 * "Open on Blendn" (D-13): the owner of a claimed venue may switch it off, and
 * then it leaves Places and the home map, which both read this list. Its events
 * still show, and still say "at <Venue>". An unclaimed venue is always listed.
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
    /*
     * The limit and the viewer's profile are independent, so they go out
     * together: a Singapore round trip each, in series, for every list (staging
     * p50 58 ms). A refused request wastes one primary-key read.
     */
    const [limited, viewer] = await Promise.all([
      // Every row carries a live count; the venue page's limit, for the same reason.
      rateLimit(request, userLimit("read", "venues", authUser.userId)),
      db.profiles.findUnique({
        where: { id: authUser.userId },
        select: { age: true, date_of_birth: true, onboarded: true },
      }),
    ])
    if (limited) return limited

    const parsed = venueQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { page, limit, search, city, lat, lon, radius, venueType, venueTypes, area, order, sortBy, sortOrder } =
      parsed.data
    // `venueType=a,b` and its spelling `venueTypes=a,b`, one set.
    const types = [...new Set([...(venueType ?? []), ...(venueTypes ?? [])])]

    // Derived, never the stored column — see lib/age.ts. A stored age is the
    // number that was true on the day they signed up.
    const viewerAge = ageFrom(viewer)
    // Who is live where is told to the people who may go live there: the venue
    // page's own gate (`personAtTheDoor` with no event). Everyone else gets null.
    const mayCountLive = mayParticipate(viewer) && isAdult(viewerAge)

    /*
     * The events that count, both for `upcomingEventCount` and for `nextEvent`:
     * one filter, written in lib/venue-listing.ts beside the summary's.
     */
    const now = new Date()
    const upcomingEventFilter = upcomingEventsWhere(typeof viewerAge === "number" ? viewerAge : null, now)

    const where = listedVenuesWhere(city)

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { address: { contains: search, mode: "insensitive" } },
        { city: { contains: search, mode: "insensitive" } },
        // The neighbourhood, so "Search places or areas" finds "Indiranagar" by name.
        { area: { contains: search, mode: "insensitive" } },
      ]
    }

    const cityScope = cityKey(city)

    if (types.length > 0) {
      where.venue_type = { in: types }
    }

    // The neighbourhood, by its slug (`areaSlug`); venues with no area are in none.
    if (area) {
      where.area_slug = area
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
      area: true,
      area_slug: true,
      floors: true,
      // What `tierOf` needs to say whether the venue is open tonight.
      timezone: true,
      day_reset_hour: true,
      hours: true,
      events: {
        where: upcomingEventFilter,
        // Id as the tiebreak, as the venue page's `upcoming`: card and page agree on which is next.
        orderBy: [{ start_time: "asc" }, { id: "asc" }],
        take: 1,
        select: {
          id: true,
          title: true,
          slug: true,
          cover_image_url: true,
          start_time: true,
          end_time: true,
          timezone: true,
        },
      },
    } satisfies Prisma.venuesSelect

    type VenueRow = Prisma.venuesGetPayload<{ select: typeof venueSelect }>

    /*
     * `order=live`: three tiers — live now, then open tonight, then the rest —
     * each in the chosen sort with the id as tiebreak, so a page boundary never
     * repeats or skips a venue. Disjoint by construction (tonight excludes live).
     */
    // What the open-tonight read depends on besides time: the query's own scope and the viewer's age rule.
    const tonightScope = JSON.stringify({ search, city: cityScope, types, area, lat, lon, radius, viewerAge, taken })
    const liveTier = order === "live" && mayCountLive ? await liveVenueIds(where, authUser.userId, now) : new Set<string>()
    const tonightTier =
      order === "live" ? await openTonightVenueIds(where, upcomingEventFilter, now, liveTier, tonightScope) : new Set<string>()
    const tiers = [[...liveTier], [...tonightTier]].filter((t) => t.length > 0)

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
      const { rows: lightweight, truncated } = await distanceCandidates(
        where,
        lat,
        lon,
        sortOrder === "asc",
        page * limit,
        DISTANCE_SORT_CEILING
      )

      if (truncated) {
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
      const tierOf = (id: string) => {
        const i = tiers.findIndex((t) => t.includes(id))
        return i === -1 ? tiers.length : i
      }
      // Array sort is stable: the distance order holds inside each tier.
      const ranked = tiers.length === 0 ? withDistance : [...withDistance].sort((a, b) => tierOf(a.id) - tierOf(b.id))
      const pageIds = ranked.slice((page - 1) * limit, page * limit).map((v) => v.id)

      const pageVenues = await db.venues.findMany({
        where: { id: { in: pageIds } },
        select: venueSelect,
      })
      // `findMany` with `in` does not preserve the order of the list.
      const byId = new Map(pageVenues.map((v) => [v.id, v]))
      venues = pageIds.map((id) => byId.get(id)).filter((v): v is VenueRow => Boolean(v))
    } else {
      // `id` after the name: two venues with one name keep one order, so a page
      // boundary between them never repeats or skips one.
      const orderBy = [{ name: sortOrder }, { id: "asc" as const }]
      const skip = (page - 1) * limit
      // The total does not depend on the page, so it is asked beside it.
      const count = db.venues.count({ where })
      const pageRead =
        tiers.length === 0
          ? db.venues.findMany({ where, select: venueSelect, orderBy, skip, take: limit })
          : tieredPage(tiers, (w, o) => db.venues.findMany({ where: { AND: [where, w] }, select: venueSelect, orderBy, ...o }), skip, limit)
      ;[venues, totalCount] = await Promise.all([pageRead, count])
    }

    /*
     * Each venue's upcoming events, counted beside the page. A relation `_count`
     * in the select is a LEFT JOIN over a GROUP BY of every upcoming event on the
     * platform; this is the page's venues only.
     */
    const pageIds = venues.map((v) => v.id)
    const [liveNow, upcomingCounts] = await Promise.all([
      mayCountLive ? liveBuckets(pageIds, authUser.userId, now) : null,
      pageIds.length
        ? db.events.groupBy({
            by: ["venue_id"],
            where: { venue_id: { in: pageIds }, ...upcomingEventFilter },
            _count: { _all: true },
          })
        : [],
    ])
    const upcomingOf = new Map(upcomingCounts.map((c) => [c.venue_id, c._count._all]))

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
        // The neighbourhood and its slug (the `area=` filter's value): `null` for both when unknown, never guessed.
        area: venue.area,
        areaSlug: venue.area_slug,
        // The 3D map's height override: floors × 3.2 m (lib/venue-floors.ts). Null: the map's own.
        floors: venue.floors,
        // Kilometres, or null when either side has no fix. The client formats
        // it — `formatDistance` there already owns km-versus-miles.
        distance,
        // Tonight's opening from `venues.hours` in the venue's own zone, or null when none is given for its current day.
        tonight: tonightHours(venue, now),
        upcomingEventCount: upcomingOf.get(venue.id) ?? 0,
        liveNow: liveNow ? (liveNow.get(venue.id) ?? "quiet") : null,
        // `live`, `open` (open tonight) or `quiet`: the tier `order=live` ranks by. Under that order
        // it is read from the very sets that ordered the page; otherwise by the same rule, per venue.
        tier:
          order === "live"
            ? liveTier.has(venue.id)
              ? "live"
              : tonightTier.has(venue.id)
                ? "open"
                : "quiet"
            : venueTier(
                venue,
                liveNow?.get(venue.id) ?? "quiet",
                next?.start_time ?? null,
                now
              ),
        nextEvent: next
          ? {
              id: next.id,
              title: next.title,
              slug: next.slug,
              coverImageUrl: next.cover_image_url,
              startTime: next.start_time,
              endTime: next.end_time,
              // The event's IANA zone (`events.timezone`), as `GET /events/:id` sends it.
              timezone: next.timezone,
            }
          : null,
      }
    })

    return successResponse({
      venues: items,
      // `order` is echoed only when it was applied, so the app knows the server honoured it.
      pagination: { ...paginationMeta(page, limit, totalCount), ...(order === "live" && { order: "live" as const }) },
    })
  } catch (error) {
    logger.error("List venues error", { error: String(error) })
    return serverErrorResponse("Failed to list venues")
  }
}

/**
 * One page over disjoint tiers of venue ids followed by everyone else: each
 * tier is a segment in sequence and the page is a window across them, so a
 * page boundary never repeats or skips a venue. `read` is the venue query
 * (already ordered, id as tiebreak) narrowed by `w`.
 */
async function tieredPage<T>(
  tiers: string[][],
  read: (w: Prisma.venuesWhereInput, o: { skip: number; take: number }) => Promise<T[]>,
  skip: number,
  limit: number
): Promise<T[]> {
  const segments = [
    ...tiers.map((ids) => ({ w: { id: { in: ids } } as Prisma.venuesWhereInput, size: ids.length })),
    { w: { id: { notIn: tiers.flat() } } as Prisma.venuesWhereInput, size: Infinity },
  ]
  const out: T[] = []
  let offset = 0
  for (const seg of segments) {
    const wanted = limit - out.length
    if (wanted <= 0) break
    const segSkip = Math.max(0, skip - offset)
    offset += seg.size
    if (segSkip >= seg.size) continue
    out.push(...(await read(seg.w, { skip: segSkip, take: Math.min(wanted, seg.size - segSkip) })))
  }
  return out
}
