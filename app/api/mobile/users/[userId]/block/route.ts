import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { blockPairIn } from "@/lib/block-pair"
import { notifyFriendshipChanged } from "@/lib/room-friends"
import { db } from "@/lib/db"
import { closeConversationRoom } from "@/lib/socket-server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { evictBlockedFromBlends } from "@/lib/crews/like"
import { blockIdFromRef, openRoomHandle, userIdFromRef } from "@/lib/room-handle"
import { ownerAdmits } from "@/lib/room-kind"
import { userIdFromDmRef } from "@/lib/conversation-ref"
import { isUuid } from "@/lib/api-input"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ userId: string }>
}

/**
 * Who a block names. A raw id or an event room's handle as `userIdFromRef`
 * reads them; a direct conversation's handle names the other person in it. A handle from a room that is not an event's — a Blend, a crew's
 * chat, a board post's room — names somebody only to a caller that room's
 * door lets in now: blocking somebody from inside a Blend is the one thing a
 * Blend handle may do outside the Blend, and only for the people in it. For
 * anybody else it stays the handle, which names nobody (404, as for an id
 * nobody has).
 */
async function blockTargetFromRef(viewerId: string, ref: string): Promise<string> {
  const opened = openRoomHandle(ref)
  if (!opened || typeof opened.scope === "string") return userIdFromRef(ref)
  // A conversation's handle: the other person of a DM you are in, whether or not they have revealed.
  if (opened.scope.kind === "dm") return (await userIdFromDmRef(viewerId, ref)) ?? ref
  return (await ownerAdmits(opened.scope.groupId, [viewerId]))?.has(viewerId) ? opened.userId : ref
}

// POST /api/mobile/users/[userId]/block — Block a user
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("safety", "block-user", authUser.userId))
    if (limited) return limited

    // A room handle or a raw id (SCRUM-371); a forged handle reads as unknown.
    const targetId = await blockTargetFromRef(authUser.userId, (await params).userId)

    if (targetId === authUser.userId) {
      return errorResponse("Cannot block yourself", 400)
    }

    // Verify target user exists
    const target = await db.user.findUnique({
      where: { id: targetId },
      select: { id: true },
    })

    if (!target) {
      return notFoundResponse("User not found")
    }

    /*
     * All of it, or none — the block, the cancelled requests, the severed
     * friendship and the closed conversation.
     *
     * These were four sequential awaits, and the partial states were all bad:
     * a block recorded with the conversation left open is a "block" that
     * removed the ability to send and nothing else; a conversation closed with
     * no block row is an unmatch the user did not ask for. The leave route
     * already wraps its equivalent trio and its docstring explains why — this
     * one had the failure mode that route was built to avoid.
     *
     * Every statement is idempotent, so a retry after a partial network failure
     * converges rather than compounding.
     */
    const closedConversationId = await db.$transaction(async (tx) => {
      // The block itself, whichever door: the lock, the row, the requests, the
      // friendship, and the conversation (lib/block-pair.ts).
      const closedId = await blockPairIn(tx, authUser.userId, targetId)

      /*
       * And the bell. Their board asks leave the blocker's list at once (hidden
       * either way), but the "Someone answered your post" line for each stayed
       * unread, pointing at an ask that no longer shows — a ghost, and a count
       * that would not clear. Marked read, not deleted: the row is the record
       * that it was sent.
       */
      // board-visibility: marks the blocker's own bell rows read; a silenced ask never wrote one, so there is nothing to leak.
      await tx.$executeRaw`
        UPDATE "notifications" SET "read_at" = now()
        WHERE "user_id" = ${authUser.userId}
          AND "kind" = 'board_request'
          AND "read_at" IS NULL
          AND "data"->>'requestId' IN (
            SELECT "id"::text FROM "board_requests"
            WHERE "from_user_id" = ${targetId} AND "to_user_id" = ${authUser.userId}
          )`

      return closedId
    })

    /*
     * Socket eviction happens after the commit, not inside it. It is not a
     * database write and cannot be rolled back, so doing it inside would mean
     * evicting people from a conversation that then stayed open.
     */
    if (closedConversationId) {
      closeConversationRoom(closedConversationId)
    }
    // A friend who was listed in Friends here is not any more (a block severs the friendship).
    void notifyFriendshipChanged(authUser.userId, targetId)
    // Out of any Blend room that now refuses them: the pair is hidden from each
    // other there, and the Blend goes on for everyone else (D-9).
    await evictBlockedFromBlends(authUser.userId, targetId)

    return successResponse({ blocked: true })
  } catch (error) {
    logger.error("Block user error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to block user")
  }
}

// DELETE /api/mobile/users/[userId]/block — Unblock a user
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("safety", "block-user", authUser.userId))
    if (limited) return limited

    const ref = (await params).userId

    /*
     * The block list's own ref (`blockRef`), which is what the list hands out
     * now. Ownership is the predicate: only a block the caller made goes.
     * A ref that names nobody's block answers as a raw id nobody has would.
     */
    const blockId = blockIdFromRef(ref)
    if (blockId !== null) {
      if (isUuid(blockId)) {
        await db.blocked_users.deleteMany({ where: { id: blockId, blocker_id: authUser.userId } })
      }
      return successResponse({ blocked: false })
    }

    // A room handle or a raw id (SCRUM-371); a forged handle reads as unknown.
    // A raw id still works, for old clients, and only on the caller's own block.
    const targetId = userIdFromRef(ref)

    await db.blocked_users.deleteMany({
      where: {
        blocker_id: authUser.userId,
        blocked_id: targetId,
      },
    })

    return successResponse({ blocked: false })
  } catch (error) {
    logger.error("Unblock user error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to unblock user")
  }
}
