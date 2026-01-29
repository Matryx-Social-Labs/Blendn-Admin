import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

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

    // Check if event exists
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Add to favorites (upsert to handle duplicates)
    await db.event_favorites.upsert({
      where: {
        event_id_user_id: {
          event_id: eventId,
          user_id: authUser.userId,
        },
      },
      create: {
        event_id: eventId,
        user_id: authUser.userId,
      },
      update: {}, // No-op if already exists
    })

    // Get updated favorite count
    const favoriteCount = await db.event_favorites.count({
      where: { event_id: eventId },
    })

    return successResponse({
      isFavorited: true,
      favoriteCount,
      message: "Event added to favorites",
    })
  } catch (error) {
    console.error("Add favorite error:", error)
    return serverErrorResponse("Failed to add favorite")
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Check if event exists
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Remove from favorites
    await db.event_favorites.deleteMany({
      where: {
        event_id: eventId,
        user_id: authUser.userId,
      },
    })

    // Get updated favorite count
    const favoriteCount = await db.event_favorites.count({
      where: { event_id: eventId },
    })

    return successResponse({
      isFavorited: false,
      favoriteCount,
      message: "Event removed from favorites",
    })
  } catch (error) {
    console.error("Remove favorite error:", error)
    return serverErrorResponse("Failed to remove favorite")
  }
}
