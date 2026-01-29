import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { getBoundingBox, haversineDistance } from "@/lib/geo"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { eventQuerySchema } from "@/lib/validations/event"

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
    } = parsed.data

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

    // Get total count
    const totalCount = await db.events.count({ where })

    // Build orderBy
    let orderBy: Record<string, string> = {}
    if (sortBy !== "distance") {
      orderBy[sortBy] = sortOrder
    } else {
      // Default sort for distance sorting (we'll sort in memory)
      orderBy = { start_time: "asc" }
    }

    // Fetch events
    let events = await db.events.findMany({
      where,
      include: {
        organizer: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        categories: {
          include: {
            category: {
              select: {
                id: true,
                name: true,
                slug: true,
                icon: true,
              },
            },
          },
        },
        media: {
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
      },
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    })

    // If sorting by distance and coordinates provided, calculate distances and sort
    if (sortBy === "distance" && lat !== undefined && lon !== undefined) {
      events = events
        .map((event) => ({
          ...event,
          distance:
            event.latitude && event.longitude
              ? haversineDistance(lat, lon, event.latitude, event.longitude)
              : null,
        }))
        .filter(
          (event) => event.distance === null || event.distance <= radius
        )
        .sort((a, b) => {
          if (a.distance === null) return 1
          if (b.distance === null) return -1
          return sortOrder === "asc"
            ? a.distance - b.distance
            : b.distance - a.distance
        }) as typeof events
    }

    // Get user's favorites for these events
    const eventIds = events.map((e) => e.id)
    const userFavorites = await db.event_favorites.findMany({
      where: {
        user_id: authUser.userId,
        event_id: { in: eventIds },
      },
      select: { event_id: true },
    })
    const favoriteEventIds = new Set(userFavorites.map((f) => f.event_id))

    // Transform response
    const transformedEvents = events.map((event) => ({
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
      city: event.city,
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
      isFavorited: favoriteEventIds.has(event.id),
      distance:
        lat !== undefined &&
        lon !== undefined &&
        event.latitude &&
        event.longitude
          ? haversineDistance(lat, lon, event.latitude, event.longitude)
          : null,
    }))

    return successResponse({
      events: transformedEvents,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
    })
  } catch (error) {
    console.error("List events error:", error)
    return serverErrorResponse("Failed to list events")
  }
}
