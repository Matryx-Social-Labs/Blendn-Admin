import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { emitEventCheckIn } from "@/lib/socket-server"
import { notifyEventCheckIn } from "@/lib/push-notifications"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { evaluateCheckIn, legacyGeofence, validateGeofence } from "@/lib/geofence"
import {
  ErrorCode,
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { checkinSchema, MAX_GPS_ACCURACY_METERS } from "@/lib/validations/event"
import { generateUniqueAnonymousName } from "@/lib/anonymous-names"
import { resolveOccurrence } from "@/lib/occurrences"
import { checkInKindFor } from "@/lib/checkin-kind"
import { checkOutOfOtherEvents } from "@/lib/checkout"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    /*
     * Rate limited on the user id, after authentication.
     *
     * It previously keyed on the last 16 characters of the raw Authorization
     * header and ran before auth — so refreshing the token handed the caller a
     * fresh bucket, which is exactly what someone probing the geofence
     * boundary would do. `userLimit` exists for this and carries a comment
     * saying header keying is the wrong choice for an authenticated route;
     * this route predates it.
     */
    const rateLimited = await rateLimit(request, userLimit("safety", "checkin", authUser.userId))
    if (rateLimited) return rateLimited

    const body = await request.json()

    // Validate input
    const parsed = checkinSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { latitude, longitude, deviceInfo } = parsed.data

    // A fix this vague tells us nothing at all — it is not evidence of being
    // anywhere. Below the ceiling, accuracy is no longer a pass/fail gate: it
    // is folded into the distance test below, which is where it belongs.
    const gpsAccuracy = deviceInfo?.gpsAccuracy
    if (gpsAccuracy !== undefined && gpsAccuracy > MAX_GPS_ACCURACY_METERS) {
      return errorResponse(
        `GPS signal is too weak (accuracy: ${Math.round(gpsAccuracy)}m). Move to an area with better signal and try again.`,
        400,
        ErrorCode.OUT_OF_RANGE
      )
    }

    // Fetch event
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      // The venue relation is needed to tell staff from guests: a check-in is
      // staff work if the person's org runs the event or owns the venue.
      include: { venue: { select: { owner_org_id: true } } },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Check if event is published
    if (event.status !== "published") {
      return errorResponse("Cannot check in to an unpublished event")
    }

    /*
     * Which day are they checking in to?
     *
     * Every event has at least one occurrence, so a single-evening event
     * resolves to its only one and behaves exactly as before. A multi-day run
     * resolves to today's session — which is what makes "who came on Wednesday"
     * answerable, and what stops Tuesday's check-in overwriting Monday's.
     *
     * This replaces the old start/end comparison against the whole event: on a
     * five-day conference that window was open for five days straight, so
     * someone could check in at 3am on the Wednesday from the hotel bar.
     */
    const now = new Date()
    const slot = await resolveOccurrence(eventId, now)

    if (!slot.ok) {
      if (slot.reason === "too_early") {
        return errorResponse("Event has not started yet", 400, ErrorCode.EVENT_NOT_STARTED)
      }
      if (slot.reason === "cancelled") {
        return errorResponse("This day has been cancelled", 400, ErrorCode.EVENT_ENDED)
      }
      // "none" means the event has no occurrences at all, which should be
      // impossible — every event gets one. Treated as ended rather than 500:
      // the attendee cannot act on the difference.
      return errorResponse("Event has already ended", 400, ErrorCode.EVENT_ENDED)
    }
    const occurrence = slot.occurrence

    /*
     * The geofence.
     *
     * Three things changed here, all of which were letting people in who should
     * not have been:
     *
     *  1. `if (event.latitude && event.longitude)` was truthiness, so an event
     *     at longitude 0 skipped the check entirely.
     *  2. An event with NO coordinates skipped it too — and nothing required
     *     coordinates to publish, so such an event accepted check-ins from
     *     anywhere on earth. It is now refused outright.
     *  3. The device's reported accuracy was a separate pass/fail gate rather
     *     than part of the distance test, so a 140m-accuracy fix 25m away
     *     passed while a good fix 35m away failed.
     *
     * `evaluateCheckIn` folds buffer and accuracy into one comparison. Legacy
     * events with no `geofence` column go through `legacyGeofence`, which maps
     * the old radius to pure extent with a zero buffer — strictly more
     * permissive than before, so nobody who could check in yesterday is
     * refused today.
     */
    // A stored geofence that fails validation falls back rather than locking
    // everyone out — bad data in one column must not take the venue offline.
    const stored = event.geofence ? validateGeofence(event.geofence) : null
    const fence = stored?.ok
      ? stored.fence
      : legacyGeofence(event.latitude, event.longitude, event.check_in_radius)

    if (!fence) {
      logger.error("Check-in attempted on an event with no geofence", { eventId })
      return errorResponse(
        "This event has no location set, so check-in is unavailable. Contact the organiser.",
        400,
        ErrorCode.OUT_OF_RANGE
      )
    }

    const verdict = evaluateCheckIn({ lat: latitude, lng: longitude }, fence, gpsAccuracy)
    if (!verdict.ok) {
      return errorResponse(
        `You're about ${Math.round(verdict.shortfall)}m outside the check-in area. Move closer to the venue and try again.`,
        400,
        ErrorCode.OUT_OF_RANGE
      )
    }

    // You cannot be in two rooms. Goes through the shared checkout path so the
    // socket event and the chat cutoff cannot be forgotten here and remembered
    // in the manual route.
    await checkOutOfOtherEvents(authUser.userId, eventId, now)

    /*
     * Capacity does not gate check-in.
     *
     * The geofence deliberately covers the pavement and the door, so a
     * 100-capacity venue with 100 inside and 20 queuing has 120 people
     * legitimately within the boundary. Refusing the hundred-and-first denied
     * them the chatroom — the actual product — and erased them from attendance,
     * leaving the organiser believing 100 came when 120 did.
     *
     * Check-in is a presence proof, not a ticket. Nothing here sells admission;
     * the door does. Occupancy is now counted from these rows (lib/occupancy.ts)
     * rather than kept in a column, so a room over its stated size becomes a
     * signal the organiser can see instead of an error the attendee hits.
     */
    // Memberships read directly rather than through `actorFor`, which wants a
    // dashboard role the mobile JWT does not carry. Passing a fabricated role
    // to get at the membership lookup would break the day `actorFor` starts
    // branching on it.
    const memberships = await db.organisation_members.findMany({
      where: { user_id: authUser.userId },
      select: { org_id: true },
    })
    const kind = checkInKindFor({ orgIds: memberships.map((m) => m.org_id) }, event)

    /*
     * Seed matching preferences from the profile.
     *
     * Only on create. Someone who set "just here" for tonight and then stepped
     * out for a cigarette must not have that silently reset to their default
     * when they check back in — the per-event answer is the one they gave most
     * recently, and re-checking in is not a decision to change it.
     */
    const prefs = await db.profiles.findUnique({
      where: { id: authUser.userId },
      select: { intent_default: true, reveal_by_default: true },
    })

    // Create or update check-in record
    const checkIn = await db.event_check_ins.upsert({
      where: {
        occurrence_id_user_id: { occurrence_id: occurrence.id, user_id: authUser.userId },
      },
      create: {
        event_id: eventId,
        occurrence_id: occurrence.id,
        user_id: authUser.userId,
        kind,
        status: "checked_in",
        check_in_time: now,
        intent: prefs?.intent_default ?? [],
        revealed: prefs?.reveal_by_default ?? false,
        latitude,
        longitude,
        device_info: deviceInfo,
      },
      update: {
        status: "checked_in",
        check_in_time: now,
        latitude,
        longitude,
        device_info: deviceInfo,
        updated_at: now,
      },
    })


    // Ensure chat group exists and add user
    let chatGroup = await db.chat_groups.findUnique({
      where: { event_id: eventId },
    })

    if (!chatGroup) {
      chatGroup = await db.chat_groups.create({
        data: {
          event_id: eventId,
          name: `${event.title} Chat`,
          description: `Chat for ${event.title}`,
          status: "active",
          member_count: 0,
        },
      })
    }

    const existingMembership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
    })

    if (existingMembership) {
      if (existingMembership.status !== "active" || existingMembership.last_allowed_at || !existingMembership.anonymous_name) {
        const anonName = existingMembership.anonymous_name || await generateUniqueAnonymousName(chatGroup.id)
        await db.chat_group_members.update({
          where: {
            chat_group_id_user_id: {
              chat_group_id: chatGroup.id,
              user_id: authUser.userId,
            },
          },
          data: {
            status: "active",
            last_allowed_at: null,
            anonymous_name: anonName,
            updated_at: now,
          },
        })
      }
    } else {
      const anonName = await generateUniqueAnonymousName(chatGroup.id)
      await db.chat_group_members.create({
        data: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
          role: "member",
          status: "active",
          last_allowed_at: null,
          anonymous_name: anonName,
        },
      })

      await db.chat_groups.update({
        where: { id: chatGroup.id },
        data: {
          member_count: {
            increment: 1,
          },
        },
      })
    }

    // Get the anonymous name for socket emit and push notification
    const updatedMembership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
      select: { anonymous_name: true },
    })
    const displayName = updatedMembership?.anonymous_name || "Someone"

    // Emit real-time check-in event (anonymous)
    emitEventCheckIn(
      eventId,
      authUser.userId,
      displayName,
      undefined
    )

    // Send push notifications to other checked-in users (async, don't await)
    db.event_check_ins
      .findMany({
        where: {
          event_id: eventId,
          status: "checked_in",
          user_id: { not: authUser.userId },
        },
        select: { user_id: true },
      })
      .then((checkIns) => {
        const userIds = checkIns.map((c) => c.user_id)
        if (userIds.length > 0) {
          return notifyEventCheckIn(
            userIds,
            displayName,
            event.title,
            eventId,
            authUser.userId
          )
        }
      })
      .catch((err) => logger.error("Push notification failed", { error: err instanceof Error ? err.message : String(err) }))

    return successResponse({
      checkIn: {
        id: checkIn.id,
        status: checkIn.status,
        checkInTime: checkIn.check_in_time,
        eventId: checkIn.event_id,
      },
      message: "Successfully checked in",
    })
  } catch (error) {
    if (error instanceof Error && error.message === "CAPACITY_FULL") {
      return errorResponse("Event is at full capacity")
    }
    logger.error("Check-in error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to check in")
  }
}
