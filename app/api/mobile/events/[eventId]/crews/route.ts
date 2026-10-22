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
import { CREW } from "@/lib/constants"
import { crewsAtEvent } from "@/lib/crews/presence"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { boundedInt } from "@/lib/pagination"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/**
 * GET /api/mobile/events/:eventId/crews?limit=&offset= — the crews here now,
 * as cards: emblem, name, "Crew of N", how many are here, tags and intent.
 * Counts only — never a name, a photo or a pseudonym. Most here first, a page
 * at a time (`limit` 30 by default, at most 50; `total`, `hasMore`). For
 * people checked in here now, as the roster is. See `crewsAtEvent`.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "event-crews", authUser.userId))
    if (limited) return limited

    const { eventId } = await params
    if (!isUuid(eventId)) return notFoundResponse("Event not found")
    const query = request.nextUrl.searchParams
    const result = await crewsAtEvent(eventId, authUser.userId, {
      limit: boundedInt(query.get("limit"), CREW.CARDS_DEFAULT, 1, CREW.CARDS_MAX),
      offset: boundedInt(query.get("offset"), 0, 0, 10_000),
    })
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
