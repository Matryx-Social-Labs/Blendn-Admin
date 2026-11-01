import { mayOpenCity } from "@/lib/browse-scope"
import { NextRequest } from "next/server"

import { ageFrom } from "@/lib/age"
import { isUuid } from "@/lib/api-input"
import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-response"
import { personAtTheDoor } from "@/lib/check-in-core"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { boundedInt, LIST_PAGE } from "@/lib/pagination"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { venueUpcoming } from "@/lib/venue-upcoming"

export const dynamic = "force-dynamic"

interface RouteParams {
  params: Promise<{ venueId: string }>
}

/** A page of the full list is this many unless `?limit=` says otherwise. */
const PAGE = 20

/**
 * GET /api/mobile/venues/:venueId/upcoming — every coming event at a venue, a
 * page at a time. `GET /venues/:id` lists the first five with `upcomingTotal`
 * and `upcomingNextCursor`; this is where "See all" goes. Same filter, same
 * order (soonest first), same age rule as that list — `lib/venue-upcoming.ts`.
 *
 * `?limit=` (1-100, default 20), `?cursor=` (a previous `nextCursor`; one that
 * is not ours is 400). Answers `{ events, pagination: { limit, hasMore,
 * nextCursor, totalCount } }`.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { venueId } = await params
    if (!isUuid(venueId)) return notFoundResponse("Venue not found")

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "venue-upcoming", authUser.userId))
    if (limited) return limited

    const venue = await db.venues.findFirst({
      where: { id: venueId, deleted_at: null, status: "active" },
      select: { id: true, city: true },
    })
    if (!venue || !(await mayOpenCity(authUser.userId, venue.city))) return notFoundResponse("Venue not found")

    const person = await personAtTheDoor(authUser.userId, null)
    if ("refusal" in person) return person.refusal

    const limit = boundedInt(request.nextUrl.searchParams.get("limit"), PAGE, 1, LIST_PAGE.MAX)
    const viewerAge = ageFrom(person.profile)
    const page = await venueUpcoming(venueId, new Date(), typeof viewerAge === "number" ? viewerAge : null, {
      limit,
      cursor: request.nextUrl.searchParams.get("cursor"),
    })
    if (page === "bad_cursor") return errorResponse("Invalid cursor", 400)

    return successResponse({
      events: page.events,
      pagination: { limit, hasMore: page.nextCursor !== null, nextCursor: page.nextCursor, totalCount: page.total },
    })
  } catch (error) {
    logger.error("Venue upcoming error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the venue’s events")
  }
}
