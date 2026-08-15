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
import { parsePagination, paginationMeta } from "@/lib/pagination"

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

    /*
     * A count. Not a directory, and not faces either.
     *
     * This first returned `{ real id, real name, real photo }` for everyone who
     * had favourited an event, to any authenticated caller, paginated with no
     * cap on enumeration — a bulk source of `{userId -> real name}` pairs that
     * key straight against the pseudonymous attendee list for anyone who both
     * saved the event and turned up, which is the ordinary path.
     *
     * The names and ids went then. **The photographs stayed**, on the reasoning
     * that a face without a name is only social proof. It is not: a face *is*
     * identity, and this was still harvestable by topic — favourite an event,
     * page through, collect the faces of everybody interested in that category.
     * A category plus a face is an inference about a person.
     *
     * Unlike the roster there is nothing here to gate on. Favouriting has no
     * check-in, no pseudonym and no reveal; it is a private act nobody consented
     * to publish. So the honest answer is the number, which is also what the
     * design asks for — the frame leads with "124+".
     *
     * `users` stays as an empty array so a build in the field iterating it gets
     * a length of zero rather than a crash on undefined.
     */
    return successResponse({
      users: [],
      interestedCount: totalCount,
      pagination: paginationMeta(page, limit, totalCount),
    })
  } catch (error) {
    logger.error("Get interested users error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get interested users")
  }
}
