import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { blockCounterparties } from "@/lib/conversations"
import { bannedRefusal, chatClosedMessage, leftByChoice } from "@/lib/chat-window"
import { roomForMember } from "@/lib/room-membership"
import { roomScope } from "@/lib/room-kind"
import { emitChatMemberLeft } from "@/lib/socket-server"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
  ErrorCode,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ chatGroupId: string }>
}

const notFound = () => notFoundResponse("Chat group not found")

/**
 * POST /api/mobile/chat/groups/:chatGroupId/leave — leave a room.
 *
 * ## What leaving does
 *
 * The row is kept and marked `left` with `left_at`, never deleted: the
 * pseudonym lives on it and every message the person sent resolves its name
 * through it (the sweeper keeps rows for the same reason, `lib/chat-lifecycle.ts`).
 * From then on the room is closed to them — reads answer "not a member"
 * (`roomReadDenial`), writes answer `LEFT_ROOM` (`mayWriteToRoom`), the socket
 * join is refused, and no push from the room reaches them (reply pushes and
 * announcements are both scoped to members still in it). Their live sockets
 * are taken out of the room now, and the room is told so rosters drop them.
 *
 * ## How they come back
 *
 * Not by opening the room. The Room tab loads the chat for the event you are
 * checked in to, so a rejoin-on-read would undo the leave the next time the
 * tab was shown. Two ways back, both deliberate:
 *
 * - **Checking in again** — the check-in route reactivates any non-banned
 *   membership, and now clears `left_at` with it.
 * - **`DELETE` on this path** — for somebody still at the venue who changed
 *   their mind, since a check-in they already hold cannot be repeated.
 *
 * Idempotent: leaving a room you already left, or were released from, answers
 * the same 200 and tells nobody twice. A banned member is already out and gets
 * the same answer; the ban is left exactly as it was.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "room-leave", authUser.userId))
    if (limited) return limited

    const { chatGroupId } = await params
    const room = await roomForMember(chatGroupId, authUser.userId)
    if (!room) return notFound()

    /*
     * Scoped on the statuses being left, so a retry, a ban or the sweeper
     * racing this request can never be overwritten — and only the request that
     * actually changed the row announces it.
     */
    const now = new Date()
    const { count } = await db.chat_group_members.updateMany({
      where: { id: room.membership.id, status: { in: ["active", "muted"] } },
      data: { status: "left", left_at: now, updated_at: now },
    })

    if (count === 1) {
      // Null when blocks cannot be read: then only the eviction runs (see the emitter).
      const blocked = await blockCounterparties(authUser.userId).catch((err: unknown) => {
        logger.error("Leave room: blocks could not be read, so nobody is told", {
          chatGroupId: room.group.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      })
      emitChatMemberLeft(room.group.id, authUser.userId, blocked, roomScope(room.group))
      logger.info("Left room", { chatGroupId: room.group.id })
    }

    return successResponse({ chatGroupId: room.group.id, left: true })
  } catch (error) {
    logger.error("Leave room error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to leave the room")
  }
}

/**
 * DELETE /api/mobile/chat/groups/:chatGroupId/leave — rejoin a room you left.
 *
 * Only undoes a leave the person made themselves (`left_at`). It cannot lift a
 * ban, and it cannot reopen a room the lifecycle sweeper released — that room's
 * window is shut, and the refusal says so in the same words a post would get.
 *
 * Somebody muted by the organiser or the pipeline when they left comes back
 * muted: leaving and rejoining must not be a way out of a mute.
 *
 * Idempotent: rejoining a room you never left answers 200 `{ left: false }`.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "room-leave", authUser.userId))
    if (limited) return limited

    const { chatGroupId } = await params
    const room = await roomForMember(chatGroupId, authUser.userId)
    if (!room) return notFound()
    const { group, membership, window } = room

    if (membership.status === "banned") {
      return errorResponse(bannedRefusal(membership), 403, ErrorCode.USER_BANNED)
    }
    if (membership.status === "active" || membership.status === "muted") {
      return successResponse({ chatGroupId: group.id, left: false })
    }

    if (!leftByChoice(membership) || !window.open) {
      const reason = window.open ? "archived" : window.reason
      return errorResponse(
        chatClosedMessage(reason),
        403,
        reason === "locked" ? ErrorCode.CHAT_LOCKED : ErrorCode.CHAT_CLOSED
      )
    }

    await db.chat_group_members.updateMany({
      where: { id: membership.id, status: "left", left_at: { not: null } },
      data: {
        status: membership.muted_at ? "muted" : "active",
        left_at: null,
        // `last_allowed_at` is left alone: in a venue day's room it is the end
        // of the caller's Go Live, and rejoining does not extend or end it.
        updated_at: new Date(),
      },
    })

    return successResponse({ chatGroupId: group.id, left: false })
  } catch (error) {
    logger.error("Rejoin room error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to rejoin the room")
  }
}
