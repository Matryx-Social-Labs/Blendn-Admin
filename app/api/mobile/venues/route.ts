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
import { realEventsWhere, venueDaysWhere } from "@/lib/event-kind"
import { liveGuestIds, liveGuestsWhere, venueLiveBucket } from "@/lib/live-count"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { mayAttendWhere, openOnBlendnWhere, undisputedLinkWhere, venuesTakenOver } from "@/lib/venue-visibility"
import { paginationMeta } from "@/lib/pagination"
import { venueDayBounds } from "@/lib/venue-day"
import { venueHours } from "@/lib/venue-hours"

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

    const { page, limit, search, city, lat, lon, radius, venueType, order, sortBy, sortOrder } =
      parsed.data

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
      // A claimed venue its owner took off Blendn (D-13). Under `AND`: the
      // search below sets `OR`, and two ORs on one object replace each other.
      AND: [openOnBlendnWhere],
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
    const tonightScope = JSON.stringify({ search, city: cityScope, venueType, lat, lon, radius, viewerAge, taken })
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
        // The 3D map's height override: floors × 3.2 m (lib/venue-floors.ts). Null: the map's own.
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
      // `order` is echoed only when it was applied, so the app knows the server honoured it.
      pagination: { ...paginationMeta(page, limit, totalCount), ...(order === "live" && { order: "live" as const }) },
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

/** The venues matching `where` whose `liveNow` is not `quiet` for this viewer. */
async function liveVenueIds(where: Prisma.venuesWhereInput, viewerId: string, now: Date): Promise<Set<string>> {
  const rows = await db.event_check_ins.findMany({
    where: { ...liveGuestsWhere(now), event: { ...venueDaysWhere, venue: where } },
    select: { event: { select: { venue_id: true } } },
    distinct: ["event_id"],
  })
  const ids = [...new Set(rows.flatMap((r) => (r.event.venue_id ? [r.event.venue_id] : [])))]
  const buckets = await liveBuckets(ids, viewerId, now)
  return new Set(ids.filter((id) => buckets.get(id) !== "quiet"))
}

/** How long the open-tonight set is kept per scope, like the live count's minute. */
const TONIGHT_TTL_MS = 60_000
/** The most venues one open-tonight read looks at per source: a scope this large is logged, not walked. */
const TONIGHT_CEILING = 5000
const tonightShared = globalThis as typeof globalThis & { __blendnTonight?: Map<string, { ids: Set<string>; at: number }> }
const tonightCache = (tonightShared.__blendnTonight ??= new Map())

/**
 * The venues matching `where`, not already live, that are open tonight: their
 * hours (`venues.hours`, in the venue's own zone) have a row for the weekday of
 * the venue's current day, or a public event (`eventFilter`, the card's) starts
 * before that day ends. "Tonight" is the venue's day, not the clock's midnight.
 *
 * `where` already carries the query's city / bounding box / search, so a read
 * is scoped to what the caller listed; the result is kept a minute per scope
 * (`scope`), so paging and refreshing do not repeat it.
 */
async function openTonightVenueIds(
  where: Prisma.venuesWhereInput,
  eventFilter: Prisma.eventsWhereInput,
  now: Date,
  live: ReadonlySet<string>,
  scope: string
): Promise<Set<string>> {
  let entry = tonightCache.get(scope)
  if (!entry || now.getTime() - entry.at >= TONIGHT_TTL_MS) {
    entry = { ids: await readOpenTonight(where, eventFilter, now), at: now.getTime() }
    if (tonightCache.size > 1000) tonightCache.clear()
    tonightCache.set(scope, entry)
  }
  return new Set([...entry.ids].filter((id) => !live.has(id)))
}

async function readOpenTonight(where: Prisma.venuesWhereInput, eventFilter: Prisma.eventsWhereInput, now: Date): Promise<Set<string>> {
  const pick = { id: true, timezone: true, day_reset_hour: true } as const
  // Events starting within a day and a half can start before some venue's day ends; each is checked against its own venue's end below.
  const soon = { ...realEventsWhere, ...eventFilter, start_time: { lt: new Date(now.getTime() + 36 * 3_600_000) } }
  const [withHours, withEvents] = await Promise.all([
    db.venues.findMany({ where: { AND: [where, { hours: { not: Prisma.DbNull } }] }, select: { ...pick, hours: true }, take: TONIGHT_CEILING }),
    db.venues.findMany({
      where: { AND: [where, { events: { some: soon } }] },
      select: { ...pick, events: { where: soon, orderBy: [{ start_time: "asc" }, { id: "asc" }], take: 1, select: { start_time: true } } },
      take: TONIGHT_CEILING,
    }),
  ])
  if (withHours.length === TONIGHT_CEILING || withEvents.length === TONIGHT_CEILING) {
    logger.warn("Open-tonight read hit its ceiling; the tier is truncated", { ceiling: TONIGHT_CEILING })
  }
  const ids = new Set<string>()
  for (const v of withHours) {
    const { localDate, end } = venueDayBounds(v.timezone, v.day_reset_hour, now)
    const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay()
    if (end > now && venueHours(v.hours)?.some((h) => h.day === weekday)) ids.add(v.id)
  }
  for (const v of withEvents) {
    const next = v.events[0]
    if (next && next.start_time < venueDayBounds(v.timezone, v.day_reset_hour, now).end) ids.add(v.id)
  }
  return ids
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
