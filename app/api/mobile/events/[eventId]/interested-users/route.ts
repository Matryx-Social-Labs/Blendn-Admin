import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { parsePagination, paginationMeta, paginationSkip } from "@/lib/pagination"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const { eventId } = await params

    // Validate eventId is a valid UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(eventId)) {
      return errorResponse("Invalid event ID format", 400)
    }

    // Parse pagination params
    const searchParams = request.nextUrl.searchParams
    const { page, limit } = parsePagination(
      searchParams.get("page") ?? undefined,
      searchParams.get("limit") ?? undefined
    )

    // Check if event exists
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Get total count
    const totalCount = await db.event_favorites.count({
      where: { event_id: eventId },
    })

    // Fetch interested users with user info
    const favorites = await db.event_favorites.findMany({
      where: { event_id: eventId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
      skip: paginationSkip(page, limit),
      take: limit,
    })

    /*
     * Social proof, not a directory.
     *
     * This returned `{ real id, real name, real photo }` for everyone who had
     * favourited an event, to any authenticated caller, paginated with no cap
     * on total enumeration. That made it a bulk source of `{userId -> real
     * name}` pairs which key straight against the pseudonymous attendee list
     * for anyone who both saved the event and turned up -- the ordinary path.
     * Gating `users/:id` would have been decorative while this stood.
     *
     * The screen wants "some people are interested". A count and avatars carry
     * that; names and ids are what made it a lookup table. `events/route.ts`
     * already uses this avatar-only shape.
     */
    return successResponse({
      users: favorites.map((f) => ({ avatar: f.user.image })),
      pagination: paginationMeta(page, limit, totalCount),
    })
  } catch (error) {
    logger.error("Get interested users error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get interested users")
  }
}
