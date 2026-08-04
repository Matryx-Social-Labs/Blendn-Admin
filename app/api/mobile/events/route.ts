import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { getBoundingBox, haversineDistance } from "@/lib/geo"
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

function buildEventsCacheKey(input: {
  page: number
  limit: number
  search?: string
  lat?: number
  lon?: number
  radius?: number
  categoryId?: string
  categorySlug?: string
  startDate?: string
  endDate?: string
  status?: string
  sortBy: string
  sortOrder: string
}) {
  return JSON.stringify({
    page: input.page,
    limit: input.limit,
    search: input.search || null,
    lat: input.lat ?? null,
    lon: input.lon ?? null,
    radius: input.radius ?? null,
    categoryId: input.categoryId || null,
    categorySlug: input.categorySlug || null,
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    status: input.status || null,
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
  })
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
      lat,
      lon,
      radius,
      categoryId,
      categorySlug,
      startDate,
      endDate,
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

    // Build where clause
    const where: Record<string, unknown> = {
      deleted_at: null,
      status: status || "published",
      visibility: "public",
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

    // Nearby filter with bounding box
    if (lat !== undefined && lon !== undefined) {
      const bbox = getBoundingBox(lat, lon, radius)
      where.latitude = { gte: bbox.minLat, lte: bbox.maxLat }
      where.longitude = { gte: bbox.minLon, lte: bbox.maxLon }
    }

    // Category filter
    if (categoryId || categorySlug) {
      where.categories = {
        some: categoryId
          ? { category_id: categoryId }
          : { category: { slug: categorySlug } },
      }
    }

    // Date filters
    if (startDate) {
      where.start_time = { gte: new Date(startDate) }
    }
    if (endDate) {
      where.end_time = { lte: new Date(endDate) }
    }

    const shouldSortByDistance =
      sortBy === "distance" && lat !== undefined && lon !== undefined

    const cacheKey = buildEventsCacheKey({
      page,
      limit,
      search,
      lat,
      lon,
      radius,
      categoryId,
      categorySlug,
      startDate,
      endDate,
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
      // Fetch only id + coordinates to sort by distance in-memory, avoiding loading
      // full relations for all rows. Only the page's worth of events get the full select.
      const lightweight = await db.events.findMany({
        where,
        select: { id: true, latitude: true, longitude: true },
      })

      const withDistance = lightweight
        .map((e) => ({
          id: e.id,
          distance:
            e.latitude && e.longitude
              ? haversineDistance(lat, lon, e.latitude, e.longitude)
              : null,
        }))
        .filter((e) => e.distance === null || e.distance <= radius)
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
