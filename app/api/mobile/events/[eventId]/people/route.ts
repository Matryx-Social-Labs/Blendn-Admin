import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import {
  ErrorCode,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { nightPeople, NIGHT_PEOPLE_DEFAULT_LIMIT, NIGHT_PEOPLE_MAX_LIMIT } from "@/lib/night-people"
import { boundedInt } from "@/lib/pagination"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/**
 * `GET /events/:eventId/people?cursor=&limit=` — the people from a night you
 * attended, for the Recap's "People from tonight" (Flow 4 · 4.5). Who appears
 * and as what: `lib/night-people.ts`.
 *
 *   404  no such event, a draft, deleted, or a venue's live room
 *   403  you never checked in to it
 *   400  `INVALID_CURSOR` a cursor that is not a card from this room
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    if (!isUuid(eventId)) return notFoundResponse("Event not found")

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    // A list a script could page through: the `read` shape.
    const limited = await rateLimit(request, userLimit("read", "night-people", authUser.userId))
    if (limited) return limited

    const search = request.nextUrl.searchParams
    const result = await nightPeople(eventId, authUser.userId, {
      cursor: search.get("cursor"),
      limit: boundedInt(search.get("limit"), NIGHT_PEOPLE_DEFAULT_LIMIT, 1, NIGHT_PEOPLE_MAX_LIMIT),
    })
    if ("refused" in result) {
      if (result.refused === "not_found") return notFoundResponse("Event not found")
      if (result.refused === "not_attended") return forbiddenResponse("Check in to see who was here")
      return errorResponse("That list has moved on. Start again from the top.", 400, ErrorCode.INVALID_CURSOR)
    }
    return successResponse(result)
  } catch (error) {
    logger.error("Night people error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load who was here")
  }
}
