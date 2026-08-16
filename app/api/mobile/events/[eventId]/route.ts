import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { Prisma, event_status } from "@prisma/client"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { haversineDistance } from "@/lib/geo"
import { resolveEventCity } from "@/lib/location"
import { getOccupancy } from "@/lib/occupancy"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Parse optional coordinates from query
    const searchParams = request.nextUrl.searchParams
    const userLat = searchParams.get("lat")
      ? parseFloat(searchParams.get("lat")!)
      : undefined
    const userLon = searchParams.get("lon")
      ? parseFloat(searchParams.get("lon")!)
      : undefined
    const includeSet = new Set(
      (searchParams.get("include") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
    const interestedLimit = Math.min(
      Math.max(parseInt(searchParams.get("interestedLimit") || "6"), 1),
      20
    )

    // Fetch event with all related data
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      include: {
        organizer: {
          select: {
            id: true,
            name: true,
            image: true,
            // No email. A host's public identity is their name and picture;
            // their address is not part of an event listing, and the list
            // endpoint never included it — only this one did.
          },
        },
        details: true,
        categories: {
          include: {
            category: {
              select: {
                id: true,
                name: true,
                slug: true,
                description: true,
                icon: true,
              },
            },
          },
        },
        media: {
          orderBy: { order: "asc" },
        },
        /*
         * Detail endpoint only, deliberately.
         *
         * The cards on the Pulse draw no amenity, and `/events` is the hottest
         * endpoint in the product — adding a join to it would cost every list
         * request for something nothing renders. `docs/AMENITIES.md` D11.
         *
         * Ordered by the vocabulary's own `sort_order` so two events with the
         * same amenities list them the same way; alphabetical would put
         * "Accessible Entrance" first on every event in the app.
         */
        amenities: {
          include: {
            amenity: {
              select: {
                id: true,
                name: true,
                slug: true,
                subtitle: true,
                icon: true,
                sort_order: true,
              },
            },
          },
          orderBy: { amenity: { sort_order: "asc" } },
        },
        chat_group: {
          select: {
            id: true,
            name: true,
            status: true,
            member_count: true,
          },
        },
        _count: {
          select: {
            check_ins: {
              where: { status: "checked_in" },
            },
            favorites: true,
            ratings: true,
            rsvps: {
              where: { status: "going" },
            },
          },
        },
      },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Counted from check-in rows rather than a stored column.
    const occupancy = await getOccupancy(eventId)

    // Get user's relationship with this event
    type InterestedUserFavorite = Prisma.event_favoritesGetPayload<{
      include: {
        user: { select: { id: true; name: true; image: true } }
      }
    }>

    const interestedUsersPromise: Promise<InterestedUserFavorite[]> =
      includeSet.has("interestedUsers")
        ? db.event_favorites.findMany({
            where: { event_id: eventId },
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  image: true,
                },
              },
            },
            orderBy: { created_at: "desc" },
            take: interestedLimit,
          })
        : Promise.resolve([])

    const [userFavorite, userRating, userCheckIn, userRsvp, interestedUsers] =
      await Promise.all([
        db.event_favorites.findUnique({
          where: {
            event_id_user_id: {
              event_id: eventId,
              user_id: authUser.userId,
            },
          },
        }),
        db.event_ratings.findUnique({
          where: {
            event_id_user_id: {
              event_id: eventId,
              user_id: authUser.userId,
            },
          },
        }),
        db.event_check_ins.findFirst({
          // Event-level: "have you been to this?" for the detail screen. A
          // multi-day run has one row per day attended, and the most recent is
          // the one whose status the client cares about.
          where: { event_id: eventId, user_id: authUser.userId },
          orderBy: { check_in_time: "desc" },
        }),
        db.event_rsvps.findUnique({
          where: {
            event_id_user_id: {
              event_id: eventId,
              user_id: authUser.userId,
            },
          },
        }),
        interestedUsersPromise,
      ])

    // Calculate average rating
    const avgRating = await db.event_ratings.aggregate({
      where: { event_id: eventId },
      _avg: { rating: true },
    })

    // Calculate distance if coordinates provided
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

    const resolvedCity = await resolveEventCity(
      event.city,
      event.latitude,
      event.longitude
    )

    return successResponse({
      id: event.id,
      slug: event.slug,
      title: event.title,
      description: event.description,
      shortDescription: event.short_description,
      coverImageUrl: event.cover_image_url,
      startTime: event.start_time,
      endTime: event.end_time,
      timezone: event.timezone,
      status: event.status,
      visibility: event.visibility,
      venueName: event.venue_name,
      address: event.address,
      city: resolvedCity,
      state: event.state,
      country: event.country,
      postalCode: event.postal_code,
      latitude: event.latitude,
      longitude: event.longitude,
      maxCapacity: event.max_capacity,
      // Null for almost every event. Returned so the app can say "18+" on the
      // detail screen rather than letting someone find out at check-in — the
      // listing hides these events from anyone whose age is known and too low,
      // but a shared link reaches this screen either way.
      minAge: event.min_age,
      // "GUEST LIST ONLY" and the like — the organiser's description of the
      // door, not a gate this API keeps. `open` for almost every event, and
      // the client draws nothing for it, falling back to remaining capacity.
      doorPolicy: event.door_policy,
      // Counted, not stored. The field name stays so no client breaks.
      currentCapacity: occupancy.inside,
      checkInRadius: event.check_in_radius,
      isFeatured: event.is_featured,
      isRecurring: event.is_recurring,
      externalLink: event.external_link,
      createdAt: event.created_at,
      organizer: event.organizer,
      details: event.details
        ? {
            fullDescription: event.details.full_description,
            houseRules: event.details.house_rules,
            cancellationPolicy: event.details.cancellation_policy,
            additionalInfo: event.details.additional_info,
            faq: event.details.faq,
            accessibilityInfo: event.details.accessibility_info,
            covidGuidelines: event.details.covid_guidelines,
          }
        : null,
      categories: event.categories.map((c) => c.category),
      /*
       * Flattened to the amenity itself — the join row carries only a
       * timestamp, and a client that has to reach through `{ amenity: {...} }`
       * for every tile is a client shaped by our schema rather than by what it
       * draws. `sort_order` is dropped: the array is already in it.
       */
      amenities: event.amenities.map((a) => ({
        id: a.amenity.id,
        name: a.amenity.name,
        slug: a.amenity.slug,
        subtitle: a.amenity.subtitle,
        icon: a.amenity.icon,
      })),
      media: event.media.map((m) => ({
        id: m.id,
        type: m.type,
        url: m.url,
        thumbnailUrl: m.thumbnail_url,
        title: m.title,
        description: m.description,
        order: m.order,
      })),
      chatGroup: event.chat_group,
      stats: {
        checkInCount: event._count.check_ins,
        favoriteCount: event._count.favorites,
        ratingCount: event._count.ratings,
        averageRating: avgRating._avg.rating,
        rsvpCount: event._count.rsvps,
      },
      userStatus: {
        isFavorited: !!userFavorite,
        isCheckedIn: userCheckIn?.status === "checked_in",
        checkInStatus: userCheckIn?.status || null,
        userRating: userRating?.rating || null,
        userReview: userRating?.review || null,
        rsvpStatus: userRsvp?.status || null,
      },
      distance,
      ...(includeSet.has("interestedUsers") && {
        interestedUsers: interestedUsers.map((f) => ({
          id: f.user.id,
          name: f.user.name,
          avatar: f.user.image,
        })),
      }),
    })
  } catch (error) {
    logger.error("Get event error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get event")
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("heavy", "event-mutate", authUser.userId))
    if (limited) return limited

    // Validate eventId is a valid UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(eventId)) {
      return errorResponse("Invalid event ID format", 400)
    }

    // Fetch event to verify ownership
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, organizer_id: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    if (event.organizer_id !== authUser.userId) {
      return forbiddenResponse("You are not the organizer of this event")
    }

    const body = await request.json()
    const { title, description, shortDescription, status } = body as {
      title?: string
      description?: string
      shortDescription?: string
      status?: string
    }

    const updated = await db.events.update({
      where: { id: eventId },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(shortDescription !== undefined && {
          short_description: shortDescription,
        }),
        ...(status !== undefined && { status: status as event_status }),
        updated_at: new Date(),
      },
    })

    return successResponse({
      id: updated.id,
      title: updated.title,
      description: updated.description,
      shortDescription: updated.short_description,
      status: updated.status,
    })
  } catch (error) {
    logger.error("Update event error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to update event")
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("heavy", "event-mutate", authUser.userId))
    if (limited) return limited

    // Validate eventId is a valid UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(eventId)) {
      return errorResponse("Invalid event ID format", 400)
    }

    // Fetch event to verify ownership
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, organizer_id: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    if (event.organizer_id !== authUser.userId) {
      return forbiddenResponse("You are not the organizer of this event")
    }

    // Soft delete
    await db.events.update({
      where: { id: eventId },
      data: { deleted_at: new Date() },
    })

    return successResponse({ success: true })
  } catch (error) {
    logger.error("Delete event error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to delete event")
  }
}
