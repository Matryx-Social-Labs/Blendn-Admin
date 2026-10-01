import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { closeConversation, conversationPair } from "@/lib/conversations"
import { lockPair, severFriendship } from "@/lib/friends"
import { db } from "@/lib/db"
import { closeConversationRoom } from "@/lib/socket-server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockIdFromRef, userIdFromRef } from "@/lib/room-handle"
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
    const targetId = userIdFromRef((await params).userId)

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
    const [user1_id, user2_id] = conversationPair(authUser.userId, targetId)

    const closedConversationId = await db.$transaction(async (tx) => {
      // The pair's friend lock first, so an accept in flight either finishes
      // before this block (and is severed below) or sees it (see lib/friends.ts).
      await lockPair(tx, authUser.userId, targetId)

      await tx.blocked_users.upsert({
        where: {
          blocker_id_blocked_id: {
            blocker_id: authUser.userId,
            blocked_id: targetId,
          },
        },
        create: {
          blocker_id: authUser.userId,
          blocked_id: targetId,
        },
        update: {},
      })

      /*
       * Cancel pending requests in BOTH directions.
       *
       * This cancelled only inbound ones, and the accept handler never re-checked
       * blocks -- so A could request B, block B, and B could then accept, creating
       * a `private_conversations` row between two blocked people. Sends were
       * refused afterwards, but both ended up with a permanent dead thread, and
       * `mayConverse` returns true forever once a row exists.
       */
      await tx.message_requests.updateMany({
        where: {
          status: "pending",
          OR: [
            { sender_id: targetId, recipient_id: authUser.userId },
            { sender_id: authUser.userId, recipient_id: targetId },
          ],
        },
        data: { status: "blocked" },
      })

      /*
       * And the friendship, with any friend request either way. A block that
       * left it standing would keep the blocked person on the blocker's
       * friends list, one tap from a DM. Not restored by unblocking: being
       * friends again is a new yes from both people.
       */
      await severFriendship(authUser.userId, targetId, tx)

      /*
       * And the bell. Their board asks leave the blocker's list at once (hidden
       * either way), but the "Someone answered your post" line for each stayed
       * unread, pointing at an ask that no longer shows — a ghost, and a count
       * that would not clear. Marked read, not deleted: the row is the record
       * that it was sent.
       */
      await tx.$executeRaw`
        UPDATE "notifications" SET "read_at" = now()
        WHERE "user_id" = ${authUser.userId}
          AND "kind" = 'board_request'
          AND "read_at" IS NULL
          AND "data"->>'requestId' IN (
            SELECT "id"::text FROM "board_requests"
            WHERE "from_user_id" = ${targetId} AND "to_user_id" = ${authUser.userId}
          )`

      /*
       * Close the conversation, if there is one.
       *
       * Blocking left the thread sitting in both inboxes with its history fully
       * readable -- so "block" removed the ability to send and nothing else. A
       * block that leaves the conversation open is not what anyone means by it.
       *
       * Block implies unmatch, and unmatch is permanent: unblocking restores
       * profile visibility, never the match — and not a new request either,
       * since a closed pair answers "not found" to one (message-requests
       * route, SCRUM-113; the app's sheet says "you won't see each other in
       * rooms again"). Driven 2026-09-18: unblock, ask → 404 (SCRUM-165).
       */
      const conversation = await tx.private_conversations.findUnique({
        where: { user1_id_user2_id: { user1_id, user2_id } },
        select: { id: true, closed_at: true },
      })
      if (!conversation || conversation.closed_at) return null

      await closeConversation(conversation.id, authUser.userId, "block", tx)
      return conversation.id
    })

    /*
     * Socket eviction happens after the commit, not inside it. It is not a
     * database write and cannot be rolled back, so doing it inside would mean
     * evicting people from a conversation that then stayed open.
     */
    if (closedConversationId) {
      closeConversationRoom(closedConversationId)
    }

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
