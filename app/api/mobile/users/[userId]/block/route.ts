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

    // Upsert block record (idempotent)
    await db.blocked_users.upsert({
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
    await db.message_requests.updateMany({
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
    const [user1_id, user2_id] = conversationPair(authUser.userId, targetId)
    const conversation = await db.private_conversations.findUnique({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      select: { id: true, closed_at: true },
    })
    if (conversation && !conversation.closed_at) {
      await closeConversation(conversation.id, authUser.userId, "block")
      closeConversationRoom(conversation.id)
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
