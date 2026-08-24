import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { cancelEventCheckIns, isCancellingEvent } from "@/lib/event-cancellation"
import { notifyEventCancelled } from "@/lib/services/event-notifications.service"
import { actorFor } from "@/lib/org-membership"
import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { mobileEventPatchSchema } from "@/lib/validations/event"
import { canPublish } from "@/lib/geofence-input"
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
  validationErrorResponse,
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

    const [attendedCounts, userFavorite, userRating, userCheckIn, userRsvp, interestedUsers] =
      await Promise.all([
        /*
         * `checkInCount` was `_count.check_ins` filtered to `checked_in`, which
         * counted rows on a table holding one per person **per day** — and
         * dropped anyone who had checked out, so the headline number fell as
         * the night went on.
         */
        distinctAttendeeCounts([eventId]),
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
        checkInCount: attendedCounts.get(eventId) ?? 0,
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

    // The resolver's shape, not a hand-picked one. `eventPermissionSelect`
    // exists so a call site cannot fetch a shape the resolver silently reads
    // as "no organiser, no venue".
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      // The location columns are here for the publish gate below, not for the
      // response: this route can flip an event to published too.
      select: {
        id: true,
        status: true,
        latitude: true,
        longitude: true,
        geofence: true,
        ...eventPermissionSelect,
      },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    /*
     * The resolver, not a comparison of two user ids.
     *
     * `organizer_id !== authUser.userId` was wrong in both directions at once.
     * Over-permissive: it is the row's CREATOR, so an ex-member of the
     * organising org whose dashboard access was correctly revoked could still
     * edit and delete the event from her phone. Under-permissive: an app_admin
     * was refused, and so was a colleague at the same org who did not happen to
     * create the row — which is exactly what moving authorization to
     * organisation membership was meant to end.
     *
     * The role comes from the database because the mobile JWT carries none:
     * a 30-day refresh cycle means a role baked into a token outlives the
     * decision that changed it.
     */
    const requester = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { id: true, role: true },
    })
    if (!requester) return forbiddenResponse("You cannot manage this event")

    const actor = await actorFor({ id: requester.id, role: requester.role })
    if (!eventPermissions(actor, event).canEdit) {
      return forbiddenResponse("You cannot manage this event")
    }

    /*
     * A schema, not a cast. `body as { … }` asserted a shape nothing checked,
     * so `{"status":"canceled"}` reached Prisma as an invalid enum value and
     * returned a 500 where a 400 belongs.
     */
    const parsed = mobileEventPatchSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const { title, description, shortDescription, status } = parsed.data

    /*
     * The same gate the dashboard PATCH runs, for the same reason and through
     * the other door: this route accepts `status: "published"` as well, and an
     * event published with no coordinates refuses every attendee at check-in
     * with OUT_OF_RANGE. The mobile body carries no location fields, so there
     * is nothing to merge — the event has a pin or it does not.
     */
    if (status === "published" && event.status !== "published") {
      const gate = canPublish(event)
      if (!gate.ok) {
        return errorResponse(gate.reason ?? "This event cannot be published yet", 400)
      }
    }

    const isCancelling = isCancellingEvent(status, event.status)

    const updated = await db.events.update({
      where: { id: eventId },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(shortDescription !== undefined && {
          short_description: shortDescription,
        }),
        ...(status !== undefined && { status }),
        updated_at: new Date(),
      },
    })

    /*
     * The same cascade the dashboard route runs (Fix #35). Cancelling here used
     * to leave every pending and checked_in row live, so a cancelled event
     * still showed attendees inside and kept counting toward occupancy — the
     * exact state Fix #35 was written to prevent, reached through the other
     * door. Both routes now call one implementation.
     */
    if (isCancelling) {
      await cancelEventCheckIns(eventId)
      // And tell them. `notifyEventCancelled` never throws — the cancellation
      // has already committed and must not be undone by a failed push.
      //
      // No `notifyEventDetailsChanged` here: this route only accepts title,
      // description and status, and none of those is a fact anybody leaves the
      // house for. Time and venue are dashboard-only edits.
      await notifyEventCancelled(updated.id, updated.title)
    }

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

    // The resolver's shape, not a hand-picked one. `eventPermissionSelect`
    // exists so a call site cannot fetch a shape the resolver silently reads
    // as "no organiser, no venue".
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, status: true, ...eventPermissionSelect },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    /*
     * The resolver, not a comparison of two user ids.
     *
     * `organizer_id !== authUser.userId` was wrong in both directions at once.
     * Over-permissive: it is the row's CREATOR, so an ex-member of the
     * organising org whose dashboard access was correctly revoked could still
     * edit and delete the event from her phone. Under-permissive: an app_admin
     * was refused, and so was a colleague at the same org who did not happen to
     * create the row — which is exactly what moving authorization to
     * organisation membership was meant to end.
     *
     * The role comes from the database because the mobile JWT carries none:
     * a 30-day refresh cycle means a role baked into a token outlives the
     * decision that changed it.
     */
    const requester = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { id: true, role: true },
    })
    if (!requester) return forbiddenResponse("You cannot manage this event")

    const actor = await actorFor({ id: requester.id, role: requester.role })
    if (!eventPermissions(actor, event).canEdit) {
      return forbiddenResponse("You cannot manage this event")
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
