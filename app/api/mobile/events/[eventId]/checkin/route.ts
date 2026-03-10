import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { haversineDistanceMeters } from "@/lib/geo"
import { emitEventCheckIn } from "@/lib/socket-server"
import { notifyEventCheckIn } from "@/lib/push-notifications"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { checkinSchema } from "@/lib/validations/event"
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

    const body = await request.json()

    // Validate input
    const parsed = checkinSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { latitude, longitude, deviceInfo } = parsed.data

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

    // Atomic check-in: capacity check + check-in creation in a single transaction
    const { checkIn, isNewCheckIn } = await db.$transaction(async (tx) => {
      // Check for existing check-in first
      const existing = await tx.event_check_ins.findUnique({
        where: {
          event_id_user_id: {
            event_id: eventId,
            user_id: authUser.userId,
          },
        },
      })

      const alreadyCheckedIn = existing?.status === "checked_in"

      // Re-fetch event inside transaction for accurate capacity
      const freshEvent = await tx.events.findUnique({
        where: { id: eventId },
        select: { max_capacity: true, current_capacity: true },
      })

      if (
        !alreadyCheckedIn &&
        freshEvent?.max_capacity &&
        freshEvent.current_capacity >= freshEvent.max_capacity
      ) {
        throw new Error("CAPACITY_FULL")
      }

      // Create or update check-in
      const result = await tx.event_check_ins.upsert({
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

      // Only increment capacity for new check-ins or re-check-ins (not already checked in)
      if (!alreadyCheckedIn) {
        await tx.events.update({
          where: { id: eventId },
          data: {
            current_capacity: {
              increment: 1,
            },
          },
        })
      }

      return { checkIn: result, isNewCheckIn: !alreadyCheckedIn }
    })

    // If capacity was full, the transaction threw — catch it below

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
