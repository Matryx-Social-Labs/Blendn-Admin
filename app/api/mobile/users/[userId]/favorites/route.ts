import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { haversineDistance } from "@/lib/geo"
import { resolveEventCity } from "@/lib/location"
import {
  successResponse,
  unauthorizedResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ userId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    /*
     * Your saved events are yours. The path `userId` drove the query and
     * `authUser` was used only to prove *someone* was logged in, so any
     * account could read any other account's list -- and the default
     * `timeFilter=upcoming` returns future events with venue, address,
     * coordinates and start time. On a product where people meet strangers
     * that is a location-prediction primitive: where a named person intends to
     * be, and when. A blocked user could run it too.
     *
     * There is no cross-user use case for this endpoint.
     */
    if (authUser.userId !== userId) {
      return forbiddenResponse("Cannot view another user's favorites")
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams
    const page = parseInt(searchParams.get("page") || "1")
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 100)
    // Fix #20: 'upcoming' (default) shows only future events; 'past' shows completed ones
    const timeFilter = searchParams.get("timeFilter") || "upcoming"
    const userLat = searchParams.get("lat")
      ? parseFloat(searchParams.get("lat")!)
      : undefined
    const userLon = searchParams.get("lon")
      ? parseFloat(searchParams.get("lon")!)
      : undefined

    const now = new Date()
    const eventTimeFilter =
      timeFilter === "past"
        ? { end_time: { lt: now } }
        : { end_time: { gte: now } }

    const eventWhereClause = {
      deleted_at: null,
      ...eventTimeFilter,
    }

    // Get total count
    const totalCount = await db.event_favorites.count({
      where: {
        user_id: userId,
        event: eventWhereClause,
      },
    })

    // Fetch favorites with event details
    const favorites = await db.event_favorites.findMany({
      where: {
        user_id: userId,
        event: eventWhereClause,
      },
      include: {
        event: {
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
              take: 1,
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
        },
      },
      orderBy: { created_at: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    })

    // Transform response
    const events = await Promise.all(favorites.map(async (f) => {
      const event = f.event
      let distance: number | null = null

      if (
        userLat !== undefined &&
        userLon !== undefined &&
        event.latitude &&
        event.longitude
      ) {
        distance = haversineDistance(
          userLat,
          userLon,
          event.latitude,
          event.longitude
        )
      }

      return {
        id: event.id,
        slug: event.slug,
        title: event.title,
        shortDescription: event.short_description,
        coverImageUrl: event.cover_image_url,
        startTime: event.start_time,
        endTime: event.end_time,
        timezone: event.timezone,
        status: event.status,
        venueName: event.venue_name,
        address: event.address,
        city: await resolveEventCity(event.city, event.latitude, event.longitude),
        state: event.state,
        country: event.country,
        latitude: event.latitude,
        longitude: event.longitude,
        isFeatured: event.is_featured,
        organizer: event.organizer,
        categories: event.categories.map((c) => c.category),
        coverImage: event.media[0] || null,
        checkInCount: event._count.check_ins,
        favoriteCount: event._count.favorites,
        ratingCount: event._count.ratings,
        favoritedAt: f.created_at,
        isFavorited: true,
        distance,
      }
    }))

    return successResponse({
      events,
      timeFilter,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
    })
  } catch (error) {
    logger.error("Get favorites error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get favorites")
  }
}
