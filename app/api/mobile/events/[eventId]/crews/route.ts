import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import {
  ErrorCode,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-response"
import { crewsAtEvent } from "@/lib/crews/presence"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/**
 * GET /api/mobile/events/:eventId/crews — the crews here now, as cards:
 * emblem, name, "Crew of N", how many are here, tags and intent, and the
 * menagerie of tonight's pseudonyms. Never a name or a photo. For people
 * checked in here now, as the roster is. See `crewsAtEvent`.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "event-crews", authUser.userId))
    if (limited) return limited

    const { eventId } = await params
    if (!isUuid(eventId)) return notFoundResponse("Event not found")
    const result = await crewsAtEvent(eventId, authUser.userId)
    if (result === null) return notFoundResponse("Event not found")
    if (result === "not_here") {
      return errorResponse("Check in to see the crews here.", 403, ErrorCode.NOT_CHECKED_IN)
    }
    return successResponse(result)
  } catch (error) {
    logger.error("Event crews error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the crews")
  }
}
