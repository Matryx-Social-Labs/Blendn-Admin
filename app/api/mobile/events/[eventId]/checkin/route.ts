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
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Check if event is published
    if (event.status !== "published") {
      return errorResponse("Cannot check in to an unpublished event")
    }

    // Check if event has started
    const now = new Date()
    if (now < event.start_time) {
      return errorResponse("Event has not started yet", 400, ErrorCode.EVENT_NOT_STARTED)
    }

    // Check if event has ended
    if (now > event.end_time) {
      return errorResponse("Event has already ended", 400, ErrorCode.EVENT_ENDED)
    }

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

    // Fix #25: Prevent checking in to multiple events simultaneously.
    // If the user is already checked in elsewhere, check them out first.
    const otherActiveCheckIn = await db.event_check_ins.findFirst({
      where: {
        user_id: authUser.userId,
        status: "checked_in",
        event_id: { not: eventId },
      },
      select: { id: true, event_id: true },
    })

    if (otherActiveCheckIn) {
      // Auto-checkout from the other event
      await db.event_check_ins.update({
        where: { id: otherActiveCheckIn.id },
        data: { status: "checked_out", check_out_time: now, updated_at: now },
      })
      await db.$executeRaw`
        UPDATE events
        SET current_capacity = GREATEST(0, current_capacity - 1)
        WHERE id = ${otherActiveCheckIn.event_id}
      `
      // Close chat access for the other event
      const otherChatGroup = await db.chat_groups.findUnique({
        where: { event_id: otherActiveCheckIn.event_id },
        select: { id: true },
      })
      if (otherChatGroup) {
        await db.chat_group_members.updateMany({
          where: { chat_group_id: otherChatGroup.id, user_id: authUser.userId },
          data: { last_allowed_at: now, updated_at: now },
        })
      }
    }

    // Find existing check-in record to determine if this is a new, returning, or duplicate check-in
    const existingCheckIn = await db.event_check_ins.findUnique({
      where: { event_id_user_id: { event_id: eventId, user_id: authUser.userId } },
      select: { id: true, status: true },
    })

    const isAlreadyCheckedIn = existingCheckIn?.status === "checked_in"
    const needsCapacityIncrement = !isAlreadyCheckedIn // new or returning attendee

    // Atomically check capacity and increment in one SQL statement to prevent overbooking.
    // Only runs for new or returning (checked_out) attendees — already-checked-in users don't count twice.
    if (needsCapacityIncrement && event.max_capacity) {
      const updated = await db.$executeRaw`
        UPDATE events
        SET current_capacity = current_capacity + 1
        WHERE id = ${eventId}
          AND current_capacity < max_capacity
      `
      if (updated === 0) {
        return errorResponse("Event is at full capacity")
      }
    } else if (needsCapacityIncrement) {
      // No max_capacity — increment freely
      await db.events.update({
        where: { id: eventId },
        data: { current_capacity: { increment: 1 } },
      })
    }

    // Create or update check-in record
    const checkIn = await db.event_check_ins.upsert({
      where: {
        event_id_user_id: {
          event_id: eventId,
          user_id: authUser.userId,
        },
      },
      create: {
        event_id: eventId,
        user_id: authUser.userId,
        status: "checked_in",
        check_in_time: now,
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
