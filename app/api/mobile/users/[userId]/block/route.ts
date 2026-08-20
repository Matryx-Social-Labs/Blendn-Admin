import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { closeConversation, conversationPair } from "@/lib/conversations"
import { db } from "@/lib/db"
import { closeConversationRoom } from "@/lib/socket-server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
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

    const { userId: targetId } = await params

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
     * All three writes, or none.
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
       * Close the conversation, if there is one.
       *
       * Blocking left the thread sitting in both inboxes with its history fully
       * readable -- so "block" removed the ability to send and nothing else. A
       * block that leaves the conversation open is not what anyone means by it.
       *
       * Block implies unmatch, and unmatch is permanent: unblocking restores
       * profile visibility and the ability to receive a request, never the match.
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

    const { userId: targetId } = await params

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
