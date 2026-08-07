import { NextRequest } from "next/server"

import {
  forbiddenResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { matchesForEvent } from "@/lib/matches"
import { getAuthenticatedUser } from "@/lib/mobile-auth"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/**
 * The people in this room, ranked for you.
 *
 * Only for people who were in it. This is a view of a room you attended, not a
 * directory anyone with a token can browse — which is the same rule the message
 * request flow enforces, applied one step earlier.
 *
 * Pseudonymous unless someone chose otherwise for this event. The card names the
 * overlaps rather than the person, so withholding the name costs almost nothing:
 * "you both picked Techno and Board games" is the useful part either way.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limit = Math.min(
      Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 50), 1),
      100
    )

    const matches = await matchesForEvent(eventId, authUser.userId, limit)
    if (matches === null) {
      return forbiddenResponse("Check in to see who else is here")
    }

    return successResponse({ matches })
  } catch (error) {
    logger.error("Matches error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load matches")
  }
}
