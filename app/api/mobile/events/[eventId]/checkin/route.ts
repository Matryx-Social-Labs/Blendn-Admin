import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { haversineDistanceMeters } from "@/lib/geo"
import { emitEventCheckIn } from "@/lib/socket-server"
import { notifyEventCheckIn } from "@/lib/push-notifications"
import { rateLimit } from "@/lib/rate-limit"
import {
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
  // Rate limit: max 10 check-in attempts per user per 10 minutes
  const rateLimited = rateLimit(request, {
    windowMs: 10 * 60 * 1000,
    maxRequests: 10,
    keyGenerator: (req) => {
      const auth = req.headers.get("authorization") || "anon"
      return `checkin:${auth.slice(-16)}`
    },
  })
  if (rateLimited) return rateLimited

  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const body = await request.json()

    // Validate input
    const parsed = checkinSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { latitude, longitude, deviceInfo } = parsed.data

    // Reject submissions with poor GPS accuracy to prevent spoofing
    const gpsAccuracy = deviceInfo?.gpsAccuracy
    if (gpsAccuracy !== undefined && gpsAccuracy > MAX_GPS_ACCURACY_METERS) {
      return errorResponse(
        `GPS signal is too weak (accuracy: ${Math.round(gpsAccuracy)}m). Move to an area with better signal and try again.`
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
      return errorResponse("Event has not started yet")
    }

    // Check if event has ended
    if (now > event.end_time) {
      return errorResponse("Event has already ended")
    }

    // Validate location if event has coordinates
    if (event.latitude && event.longitude) {
      const distanceMeters = haversineDistanceMeters(
        latitude,
        longitude,
        event.latitude,
        event.longitude
      )

      // check_in_radius is stored in meters
      if (distanceMeters > event.check_in_radius) {
        return errorResponse(
          `You must be within ${event.check_in_radius} meters of the event to check in. You are currently ${Math.round(distanceMeters)} meters away.`
        )
      }
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
      .catch((err) => console.error("Push notification failed:", err))

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
    console.error("Check-in error:", error)
    return serverErrorResponse("Failed to check in")
  }
}
