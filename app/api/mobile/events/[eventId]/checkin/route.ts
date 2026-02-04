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

    // Check capacity
    if (event.max_capacity && event.current_capacity >= event.max_capacity) {
      return errorResponse("Event is at full capacity")
    }

    // Create or update check-in
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

    // Update event capacity
    await db.events.update({
      where: { id: eventId },
      data: {
        current_capacity: {
          increment: 1,
        },
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
      if (existingMembership.status !== "active") {
        await db.chat_group_members.update({
          where: {
            chat_group_id_user_id: {
              chat_group_id: chatGroup.id,
              user_id: authUser.userId,
            },
          },
          data: {
            status: "active",
            updated_at: now,
          },
        })
      }
    } else {
      await db.chat_group_members.create({
        data: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
          role: "member",
          status: "active",
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

    // Get user profile for socket emit
    const userProfile = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { name: true, image: true },
    })

    // Emit real-time check-in event
    emitEventCheckIn(
      eventId,
      authUser.userId,
      userProfile?.name || "Unknown",
      userProfile?.image || undefined
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
            userProfile?.name || "Someone",
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
    console.error("Check-in error:", error)
    return serverErrorResponse("Failed to check in")
  }
}
