import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { attendeeEventAccess, eventAccessResponse } from "@/lib/event-access"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
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

    const limited = await rateLimit(request, userLimit("write", "favorite", authUser.userId))
    if (limited) return limited

    const denied = await attendeeEventAccess(authUser.userId, eventId, "participate")
    if (denied) return eventAccessResponse(denied)

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
    logger.error("Add favorite error", { error: error instanceof Error ? error.message : String(error) })
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

    const limited = await rateLimit(request, userLimit("write", "favorite", authUser.userId))
    if (limited) return limited

    // Same answer as POST for a draft or a stranger's private event; removing
    // a save is never refused on age.
    const denied = await attendeeEventAccess(authUser.userId, eventId, "view")
    if (denied?.kind === "not_found") return eventAccessResponse(denied)

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
    logger.error("Remove favorite error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to remove favorite")
  }
}
