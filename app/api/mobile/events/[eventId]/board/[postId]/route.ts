import { NextRequest } from "next/server"

import {
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  errorResponse,
} from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { isUuid } from "@/lib/api-input"
import { closePostRooms } from "@/lib/room-close"
import { lobbyPhase } from "@/lib/board"
import { chatClosesAt } from "@/lib/chat-window"
import { hiddenAuthorsFor, livePostsWhere, postSelect, shapePosts } from "@/lib/lobby"
import { lobbyDoor } from "@/lib/lobby-route"

interface RouteParams {
  params: Promise<{ eventId: string; postId: string }>
}

/**
 * One post, for a link that opens the Lobby at it (SCRUM-1026). The Lobby's
 * door and its read, so a gated reader gets the gate's refusal, a closed Lobby
 * the closed one, and a post that is gone, or by somebody hidden from the
 * caller, the same 404 as one that never existed.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId, postId } = await params
    if (!isUuid(postId)) return errorResponse("Invalid post ID format", 400)
    const door = await lobbyDoor(request, eventId)
    if (door instanceof Response) return door
    const { userId, event, state } = door

    const row = await db.board_posts.findFirst({
      where: { AND: [livePostsWhere(event, await hiddenAuthorsFor(userId)), { id: postId }] },
      select: postSelect(userId),
    })
    if (!row) return notFoundResponse("That post is no longer in the Lobby")
    const [post] = await shapePosts(eventId, [row], userId)
    return successResponse({ state, phase: lobbyPhase(state), closesAt: chatClosesAt(event), post })
  } catch (error) {
    logger.error("Lobby post read error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the post")
  }
}

/**
 * The author takes their post back (SCRUM-301).
 *
 * Soft: `deleted_at`, which every board read already filters, and which
 * `liveRequest()` reads so the requests people filed against it stop counting
 * toward their limits. Somebody else's post, or one already gone, is a 404 —
 * not a 403 that would confirm it exists.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "board-withdraw", user.userId))
    if (limited) return limited

    const { eventId, postId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
    if (!isUuid(postId)) return errorResponse("Invalid post ID format", 400)
    const now = new Date()
    const { count } = await db.board_posts.updateMany({
      where: { id: postId, event_id: eventId, author_id: user.userId, deleted_at: null },
      data: { deleted_at: now, updated_at: now },
    })
    if (count === 0) return notFoundResponse("Post not found")
    // Withdrawn, so its room is closed: out with anyone still in it (E3).
    void closePostRooms([postId])

    return successResponse({ id: postId, withdrawn: true })
  } catch (error) {
    logger.error("Board withdraw error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to withdraw")
  }
}
