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
import { db } from "@/lib/db"
import { inRoomWhere } from "@/lib/event-kind"
import {
  BadCursor,
  FRIENDS_HERE_DEFAULT_LIMIT,
  FRIENDS_HERE_MAX_LIMIT,
  FRIENDS_HERE_MAX_QUERY,
  friendsHere,
  type FriendsHereOrder,
} from "@/lib/friends-here"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { boundedInt } from "@/lib/pagination"

/**
 * GET /api/mobile/events/:eventId/friends-here — the friends here who let friends
 * see them, by real id, with a Message action on the client (plans/friends-in-room.md).
 *
 * `order=recent` (default): the people you last talked to first, then the newest
 * arrival; `limit` defaults to 8 and is clamped to 50. `order=name`: A-Z with a
 * cursor (`nextCursor`) and an optional `q` (1-40 characters, a word prefix),
 * for "See all". `total` is every friend listed for you here, so the count the
 * client shows is the truth, never `friends.length`. No event, room or arrival
 * time is in the payload: friend rows carry no context.
 *
 * Friends are on no stranger surface; this is the one place they appear.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("read", "friends-here", authUser.userId))
    if (limited) return limited

    const search = request.nextUrl.searchParams
    const order: FriendsHereOrder = search.get("order") === "name" ? "name" : "recent"
    const limit = boundedInt(search.get("limit"), FRIENDS_HERE_DEFAULT_LIMIT, 1, FRIENDS_HERE_MAX_LIMIT)
    const cursor = order === "name" ? (search.get("cursor") ?? undefined) : undefined
    const rawQ = order === "name" ? search.get("q")?.trim() : undefined
    if (rawQ !== undefined && rawQ.length > FRIENDS_HERE_MAX_QUERY) return errorResponse("That search is too long", 400)
    const q = rawQ || undefined

    const event = await db.events.findUnique({ where: { id: eventId, deleted_at: null }, select: { id: true, status: true } })
    if (!event || event.status === "draft") return notFoundResponse("Event not found")

    // The roster's gate: you see who is here while you are here (a venue day: while live).
    const attended = await db.event_check_ins.findFirst({
      where: { event_id: eventId, user_id: authUser.userId, ...inRoomWhere(authUser.userId) },
      select: { id: true },
    })
    if (!attended) return errorResponse("Check in to see who else is here", 403, ErrorCode.NOT_CHECKED_IN)

    return successResponse(await friendsHere(eventId, authUser.userId, { order, limit, cursor, q }))
  } catch (error) {
    if (error instanceof BadCursor) return errorResponse("Invalid cursor", 400)
    logger.error("Friends here error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load friends here")
  }
}
