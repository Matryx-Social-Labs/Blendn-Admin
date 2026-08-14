import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { getBoundingBox, haversineDistance } from "@/lib/geo"
import { ageFrom } from "@/lib/age"
import { normalizeLocationToCity, resolveEventCity } from "@/lib/location"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { eventQuerySchema } from "@/lib/validations/event"
import {
  eventListSelect,
  type EventListItem,
  transformEvents,
} from "@/lib/services/events.service"
import { EVENTS_CACHE_TTL_MS, EVENTS_CACHE_MAX_SIZE } from "@/lib/constants"
import { buildEventsCacheKey } from "@/lib/events-cache-key"

/**
 * The most events a distance sort will pull into memory at once.
 *
 * Sized to be unreachable in practice and to fail loudly if it ever is not —
 * see the fetch it guards. Not a page size: the page is taken from the sorted
 * result, so this only bounds what gets sorted.
 */
const DISTANCE_SORT_CEILING = 5000

// Bounded LRU-style cache with max size and TTL eviction
const eventsCache = new Map<
  string,
  { expiresAt: number; events: EventListItem[]; totalCount: number }
>()

function setCache(key: string, value: { expiresAt: number; events: EventListItem[]; totalCount: number }) {
  // Evict expired entries if cache is at capacity
  if (eventsCache.size >= EVENTS_CACHE_MAX_SIZE) {
    const now = Date.now()
    for (const [k, v] of eventsCache) {
      if (v.expiresAt <= now) eventsCache.delete(k)
    }
    // If still at capacity, delete oldest entry
    if (eventsCache.size >= EVENTS_CACHE_MAX_SIZE) {
      const firstKey = eventsCache.keys().next().value
      if (firstKey) eventsCache.delete(firstKey)
    }
  }
  eventsCache.set(key, value)
}

export async function GET(request: NextRequest) {
  try {
    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Parse query parameters
    const searchParams = Object.fromEntries(request.nextUrl.searchParams)
    const parsed = eventQuerySchema.safeParse(searchParams)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const {
      page,
      limit,
      search,
      city,
      lat,
      lon,
      radius,
      categoryId,
      categorySlug,
      startDate,
      endDate,
      includePast,
      status,
      sortBy,
      sortOrder,
      include,
      interestedPreviewLimit,
    } = parsed.data

    const includeSet = new Set(
      (include || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
    const previewLimit = interestedPreviewLimit ?? 3

    /*
     * `status` used to be caller-supplied and the schema accepts "draft", with
     * no ownership scoping anywhere in this handler. Since `events.status`
     * defaults to `draft` and `visibility` to `public`, every event is a
     * public draft from creation until it is published -- so
     * `?status=draft&includePast=true` returned every unannounced event on the
     * platform to any attendee, line-up, venue, date and capacity included.
     * `/events/search` gets this right and pins both columns in SQL.
     *
     * Discovery serves published public events. A host reads their own drafts
     * through the dashboard, which scopes by organisation.
     */
    const where: Record<string, unknown> = {
      deleted_at: null,
      status: "published",
      visibility: "public",
    }

    /*
     * Don't show someone a room they would be turned away from.
     *
     * Only when we know their age. An unknown age does **not** hide restricted
     * events: OAuth accounts are created without one, so failing closed here
     * would empty the feed for most of them in order to punish a missing field.
     * Check-in refuses an unknown age regardless — the listing is discovery,
     * the door is the gate — so the worst case is a wasted tap with a message
     * naming the fix, rather than a product that appears to have no events.
     */
    const viewer = await db.profiles.findUnique({
      where: { id: authUser.userId },
      select: { age: true, date_of_birth: true },
    })
    // Derived, never read straight off the row: a stored age is the number that
    // was true on the day they signed up. See `ageFrom` in lib/age.ts.
    const viewerAge = ageFrom(viewer)
    if (typeof viewerAge === "number") {
      // In `AND`, not `OR`: the search filter below assigns `where.OR` outright,
      // and an age restriction that a search term silently removes is worse
      // than no age restriction at all.
      where.AND = [{ OR: [{ min_age: null }, { min_age: { lte: viewerAge } }] }]
    }

    /*
     * Discovery excludes events that have already finished.
     *
     * There was no time filter at all, so every event ever published stayed in
     * the feed forever — on production that meant all ten events, every one of
     * them already over, presented as things to go to.
     *
     * `includePast=true` still returns them, because "my past events" and
     * "search history" are real screens; they just have to ask.
     */
    if (!includePast) {
      where.end_time = { gte: new Date() }
    }

    // Search filter
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { venue_name: { contains: search, mode: "insensitive" } },
        { city: { contains: search, mode: "insensitive" } },
      ]
    }

    /*
     * The browse scope.
     *
     * `equals` with `mode: "insensitive"` rather than `contains`: `search`
     * above already matches loosely across four columns, and a scope that also
     * matches substrings is not a scope. Case-insensitive because rows written
     * before `lib/address.ts` existed may differ only in case, and "bengaluru"
     * and "Bengaluru" are one place to everyone except a database.
     *
     * Events with no city are unreachable this way, which is deliberate and
     * matches `/events/cities` — the picker lists exactly what the filter can
     * find, so a city can never show a count and then open empty.
     * `scripts/backfill-event-cities.ts` is what gives the older rows a city.
     */
    if (city) {
      where.city = { equals: city, mode: "insensitive" }
    }

    /*
     * A bounding box **only when the caller asked for one.**
     *
     * `radius` used to default to 10 km, so simply sending coordinates —
     * which the home screen does, to sort by distance — silently filtered the
     * result to a 10 km box. That is the bug that blanked the homepage for
     * anyone standing outside one.
     *
     * Half-fixing this is easy and would look like it worked: there is a
     * second radius filter further down, applied after the distance sort.
     */
    if (lat !== undefined && lon !== undefined && radius !== undefined) {
      const bbox = getBoundingBox(lat, lon, radius)
      where.latitude = { gte: bbox.minLat, lte: bbox.maxLat }
      where.longitude = { gte: bbox.minLon, lte: bbox.maxLon }
    }

    /*
     * Category filter, parent-inclusive.
     *
     * Events are tagged to leaves — "IPL screening", not "Sports" — so matching
     * the id exactly means picking a parent returns nothing at all. Filtering
     * by a parent has to sweep in its children.
     *
     * Expressed as a relation OR rather than a second query for the children:
     * one round trip, and it is correct for a leaf too, since a leaf simply has
     * no rows whose parent is it.
     *
     * This assumes the two-level taxonomy the product actually uses. A third
     * level would be matched at depth one and silently miss its grandchildren,
     * which is why the seed keeps the tree flat at two.
     */
    if (categoryId || categorySlug) {
      where.categories = {
        some: {
          category: categoryId
            ? { OR: [{ id: categoryId }, { parent_id: categoryId }] }
            : { OR: [{ slug: categorySlug }, { parent: { slug: categorySlug } }] },
        },
      }
    }

    // Date filters
    if (startDate) {
      where.start_time = { gte: new Date(startDate) }
    }
    if (endDate) {
      // Merge rather than assign: overwriting would silently drop the
      // not-yet-ended constraint set above and put past events back in the feed.
      where.end_time = { ...(where.end_time as object ?? {}), lte: new Date(endDate) }
    }

    const shouldSortByDistance =
      sortBy === "distance" && lat !== undefined && lon !== undefined

    const cacheKey = buildEventsCacheKey({
      page,
      limit,
      search,
      city,
      // The DERIVED age, matching the filter above. Keying on the stored number
      // would let two viewers with the same signup-day age but different
      // birthdays share an entry — and on a birthday, serve yesterday's list.
      viewerAge,
      lat,
      lon,
      radius,
      categoryId,
      categorySlug,
      startDate,
      endDate,
      // Part of the key, not decoration: two requests differing only by this
      // return different event sets, so omitting it would let a history
      // response be served straight back to a discovery request.
      includePast,
      status,
      sortBy,
      sortOrder,
    })

    const cached = eventsCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      const events = cached.events
      const totalCount = cached.totalCount

      const eventIds = events.map((e) => e.id)

      // Get user's favorites for these events
      const userFavoritesPromise = db.event_favorites.findMany({
        where: {
          user_id: authUser.userId,
          event_id: { in: eventIds },
        },
        select: { event_id: true },
      })

      const userCheckinsPromise = includeSet.has("checkins")
        ? db.event_check_ins.findMany({
            where: {
              user_id: authUser.userId,
              event_id: { in: eventIds },
            },
            select: {
              event_id: true,
              id: true,
              status: true,
              check_in_time: true,
            },
          })
        : Promise.resolve([])

      const activeCheckinsPromise = includeSet.has("activeCheckins")
        ? db.event_check_ins.findMany({
            where: {
              user_id: authUser.userId,
              status: "checked_in",
            },
            include: {
              event: {
                select: {
                  id: true,
                  title: true,
                  slug: true,
                  cover_image_url: true,
                  start_time: true,
                  end_time: true,
                  venue_name: true,
                  address: true,
                  city: true,
                  status: true,
                },
              },
            },
            orderBy: { check_in_time: "desc" },
          })
        : Promise.resolve([])

      const profilePromise = includeSet.has("profile")
        ? db.user.findUnique({
            where: { id: authUser.userId },
            select: {
              id: true,
              name: true,
              image: true,
              profile: true,
            },
          })
        : Promise.resolve(null)

      const [userFavorites, userCheckins, activeCheckins, profile] =
        await Promise.all([
          userFavoritesPromise,
          userCheckinsPromise,
          activeCheckinsPromise,
          profilePromise,
        ])

      const favoriteEventIds = new Set(userFavorites.map((f) => f.event_id))

      const userCheckinMap: Record<
        string,
        { status: string; checkInId?: string; checkInTime?: Date | null }
      > = {}
      if (includeSet.has("checkins")) {
        for (const checkIn of userCheckins) {
          userCheckinMap[checkIn.event_id] = {
            status: checkIn.status,
            checkInId: checkIn.id,
            checkInTime: checkIn.check_in_time,
          }
        }
      }

      const interestedPreviewMap: Record<string, string[]> = {}
      if (includeSet.has("interestedPreview")) {
        const favorites = await db.event_favorites.findMany({
          where: {
            event_id: { in: eventIds },
          },
          select: {
            event_id: true,
            user: {
              select: { image: true },
            },
          },
          orderBy: { created_at: "desc" },
        })
        const counts: Record<string, number> = {}
        for (const fav of favorites) {
          const img = fav.user?.image
          if (!img) continue
          if (!interestedPreviewMap[fav.event_id]) {
            interestedPreviewMap[fav.event_id] = []
          }
          counts[fav.event_id] = counts[fav.event_id] || 0
          if (counts[fav.event_id] < previewLimit) {
            interestedPreviewMap[fav.event_id].push(img)
            counts[fav.event_id] += 1
          }
        }
      }

      const transformedEvents = await transformEvents(events, {
        favoriteEventIds,
        userCheckinMap,
        interestedPreviewMap,
        userLat: lat,
        userLon: lon,
        includeCheckins: includeSet.has("checkins"),
        includeInterestedPreview: includeSet.has("interestedPreview"),
      })

      const normalizedProfile = profile?.profile
        ? {
            ...profile,
            profile: {
              ...profile.profile,
              location: await normalizeLocationToCity(profile.profile.location),
            },
          }
        : profile

      return successResponse({
        events: transformedEvents,
        pagination: {
          page,
          limit,
          totalCount,
          totalPages: Math.ceil(totalCount / limit),
          hasMore: page * limit < totalCount,
        },
        ...(includeSet.has("activeCheckins") && {
          activeCheckins: await Promise.all(
            activeCheckins.map(async (c) => ({
              id: c.id,
              eventId: c.event_id,
              checkInTime: c.check_in_time,
              event: {
                id: c.event.id,
                title: c.event.title,
                slug: c.event.slug,
                coverImageUrl: c.event.cover_image_url,
                startTime: c.event.start_time,
                endTime: c.event.end_time,
                venueName: c.event.venue_name,
                address: c.event.address,
                city: await resolveEventCity(
                  c.event.city,
                  null,
                  null
                ),
                status: c.event.status,
              },
            }))
          ),
        }),
        ...(includeSet.has("profile") && {
          profile: normalizedProfile,
        }),
      })
    }

    // Build orderBy
    const orderBy: Record<string, string> = shouldSortByDistance
      ? { start_time: "asc" }
      : { [sortBy]: sortOrder }

    let events: EventListItem[]
    let totalCount: number


    if (shouldSortByDistance) {
      /*
       * Fetch only id + coordinates to sort by distance in-memory, avoiding
       * loading full relations for all rows. Only the page's worth of events
       * get the full select.
       *
       * `take` is a backstop, not tuning. This used to be bounded in practice
       * by the 10 km radius that was applied before it; with distance demoted
       * to a sort, an unscoped `sortBy=distance` would pull every future public
       * event on the platform into memory. Three columns per row is cheap, but
       * cheap times unbounded is still unbounded.
       *
       * Ordered by `start_time` so the ceiling, if it is ever hit, drops the
       * furthest-off events rather than an arbitrary slice — and the drop is
       * logged rather than silent, because a discovery list that quietly stops
       * being complete is the kind of bug nobody reports.
       *
       * Past this, the sort belongs in SQL. That is the seam `lib/geofence.ts`
       * already names as the point where a real spatial index would earn its
       * migration.
       */
      const lightweight = await db.events.findMany({
        where,
        select: { id: true, latitude: true, longitude: true },
        orderBy: { start_time: "asc" },
        take: DISTANCE_SORT_CEILING,
      })

      if (lightweight.length === DISTANCE_SORT_CEILING) {
        logger.warn("Distance sort hit its ceiling; results are truncated", {
          ceiling: DISTANCE_SORT_CEILING,
          city: city ?? null,
        })
      }

      const withDistance = lightweight
        .map((e) => ({
          id: e.id,
          distance:
            e.latitude && e.longitude
              ? haversineDistance(lat, lon, e.latitude, e.longitude)
              : null,
        }))
        // The second radius filter. Only bites when the caller asked for a
        // bounded search — see the bounding box above, which is the other half
        // of the same decision and was easy to fix alone and believe done.
        .filter((e) => radius === undefined || e.distance === null || e.distance <= radius)
        .sort((a, b) => {
          if (a.distance === null) return 1
          if (b.distance === null) return -1
          return sortOrder === "asc"
            ? a.distance - b.distance
            : b.distance - a.distance
        })

      totalCount = withDistance.length
      const pageIds = withDistance
        .slice((page - 1) * limit, page * limit)
        .map((e) => e.id)

      // Fetch full data only for the current page's events
      const pageEvents = await db.events.findMany({
        where: { id: { in: pageIds } },
        select: eventListSelect,
      })
      // Restore distance order (findMany with `in` doesn't preserve order)
      const eventMap = new Map(pageEvents.map((e) => [e.id, e]))
      events = pageIds.map((id) => eventMap.get(id)!).filter(Boolean)
    } else {
      events = await db.events.findMany({
        where,
        select: eventListSelect,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      })
      totalCount = await db.events.count({ where })
    }

    setCache(cacheKey, {
      expiresAt: Date.now() + EVENTS_CACHE_TTL_MS,
      events,
      totalCount,
    })

    const eventIds = events.map((e) => e.id)

    // Get user's favorites for these events
    const userFavoritesPromise = db.event_favorites.findMany({
      where: {
        user_id: authUser.userId,
        event_id: { in: eventIds },
      },
      select: { event_id: true },
    })

    // Optional includes
    const userCheckinsPromise = includeSet.has("checkins")
      ? db.event_check_ins.findMany({
          where: {
            user_id: authUser.userId,
            event_id: { in: eventIds },
          },
          select: {
            event_id: true,
            id: true,
            status: true,
            check_in_time: true,
          },
        })
      : Promise.resolve([])

    const activeCheckinsPromise = includeSet.has("activeCheckins")
      ? db.event_check_ins.findMany({
          where: {
            user_id: authUser.userId,
            status: "checked_in",
          },
          include: {
            event: {
              select: {
                id: true,
                title: true,
                slug: true,
                cover_image_url: true,
                start_time: true,
                end_time: true,
                venue_name: true,
                address: true,
                city: true,
                status: true,
              },
            },
          },
          orderBy: { check_in_time: "desc" },
        })
      : Promise.resolve([])

    const profilePromise = includeSet.has("profile")
      ? db.user.findUnique({
          where: { id: authUser.userId },
          select: {
            id: true,
            name: true,
            image: true,
            profile: true,
          },
        })
      : Promise.resolve(null)

    const interestedPreviewPromise = includeSet.has("interestedPreview")
      ? db.event_favorites.findMany({
          where: {
            event_id: { in: eventIds },
          },
          select: {
            event_id: true,
            user: {
              select: { image: true },
            },
          },
          orderBy: { created_at: "desc" },
        })
      : Promise.resolve([])

    const [userFavorites, userCheckins, activeCheckins, profile, interestedFavorites] =
      await Promise.all([
        userFavoritesPromise,
        userCheckinsPromise,
        activeCheckinsPromise,
        profilePromise,
        interestedPreviewPromise,
      ])

    const favoriteEventIds = new Set(userFavorites.map((f) => f.event_id))

    const userCheckinMap: Record<
      string,
      { status: string; checkInId?: string; checkInTime?: Date | null }
    > = {}
    if (includeSet.has("checkins")) {
      for (const checkIn of userCheckins) {
        userCheckinMap[checkIn.event_id] = {
          status: checkIn.status,
          checkInId: checkIn.id,
          checkInTime: checkIn.check_in_time,
        }
      }
    }

    const interestedPreviewMap: Record<string, string[]> = {}
    if (includeSet.has("interestedPreview")) {
      const counts: Record<string, number> = {}
      for (const fav of interestedFavorites) {
        const img = fav.user?.image
        if (!img) continue
        if (!interestedPreviewMap[fav.event_id]) {
          interestedPreviewMap[fav.event_id] = []
        }
        counts[fav.event_id] = counts[fav.event_id] || 0
        if (counts[fav.event_id] < previewLimit) {
          interestedPreviewMap[fav.event_id].push(img)
          counts[fav.event_id] += 1
        }
      }
    }

    // Transform response
    const transformedEvents = await transformEvents(events, {
      favoriteEventIds,
      userCheckinMap,
      interestedPreviewMap,
      userLat: lat,
      userLon: lon,
      includeCheckins: includeSet.has("checkins"),
      includeInterestedPreview: includeSet.has("interestedPreview"),
    })

    const normalizedProfile = profile?.profile
      ? {
          ...profile,
          profile: {
            ...profile.profile,
            location: await normalizeLocationToCity(profile.profile.location),
          },
        }
      : profile

    return successResponse({
      events: transformedEvents,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
      ...(includeSet.has("activeCheckins") && {
        activeCheckins: await Promise.all(
          activeCheckins.map(async (c) => ({
            id: c.id,
            eventId: c.event_id,
            checkInTime: c.check_in_time,
            event: {
              id: c.event.id,
              title: c.event.title,
              slug: c.event.slug,
              coverImageUrl: c.event.cover_image_url,
              startTime: c.event.start_time,
              endTime: c.event.end_time,
              venueName: c.event.venue_name,
              address: c.event.address,
              city: await resolveEventCity(c.event.city, null, null),
              status: c.event.status,
            },
          }))
        ),
      }),
      ...(includeSet.has("profile") && {
        profile: normalizedProfile,
      }),
    })
  } catch (error) {
    logger.error("List events error", { error: String(error) })
    return serverErrorResponse("Failed to list events")
  }
}
