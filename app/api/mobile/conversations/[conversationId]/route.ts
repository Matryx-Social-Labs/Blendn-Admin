import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { closeConversation } from "@/lib/conversations"
import { displayNameInConversation, mayShowRealName } from "@/lib/conversation-identity"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { closeConversationRoom } from "@/lib/socket-server"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ conversationId: string }>
}

// GET /api/mobile/conversations/[conversationId] - Get conversation details
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const conversation = await db.private_conversations.findUnique({
      where: { id: conversationId },
      include: {
        user1: { select: { id: true, name: true, image: true } },
        user2: { select: { id: true, name: true, image: true } },
      },
    })

    if (!conversation) {
      return notFoundResponse("Conversation not found")
    }

    // Verify user is part of the conversation
    if (
      conversation.user1_id !== authUser.userId &&
      conversation.user2_id !== authUser.userId
    ) {
      return forbiddenResponse("Not authorized to view this conversation")
    }

    // Closed conversations are gone for both people. Retained for moderation,
    // not readable by the participants -- see lib/conversations.ts.
    if (conversation.closed_at) {
      return notFoundResponse("Conversation not found")
    }

    const otherUser =
      conversation.user1_id === authUser.userId
        ? conversation.user2
        : conversation.user1

    // Same gate as the inbox. A detail view that named someone the list had
    // kept pseudonymous would make the rule one tap deep.
    const theyRevealed = mayShowRealName(conversation, otherUser.id)
    const isUser1 = conversation.user1_id === authUser.userId

    return successResponse({
      id: conversation.id,
      otherUser: {
        ...otherUser,
        name: displayNameInConversation(conversation, otherUser.id, otherUser.name),
        image: theyRevealed ? otherUser.image : null,
      },
      youRevealed: isUser1 ? conversation.user1_revealed : conversation.user2_revealed,
      theyRevealed,
      revealRequested: isUser1
        ? conversation.user1_reveal_requested
        : conversation.user2_reveal_requested,
      createdAt: conversation.created_at,
      lastMessageAt: conversation.last_message_at,
    })
  } catch (error) {
    logger.error("Get conversation error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get conversation")
  }
}

/**
 * DELETE /api/mobile/conversations/[conversationId] — leave the conversation.
 *
 * **This used to hard-delete the row, cascading every message.** Either
 * participant could call it, and the messages went with it — so one person
 * could destroy the other's history without consent, and, far worse, the
 * subject of a report could destroy the evidence against themselves.
 * `message_reports.message_id` carries no foreign key, so the report survived
 * while its content did not, and the admin queue was then left with a null
 * excerpt, a null author, and `resolveReport` refusing to suspend anyone
 * (`app/dashboard/moderation/reports/actions.ts:261`). Send abuse, get
 * reported, delete the thread, walk away.
 *
 * It now closes: hidden from both inboxes, refuses new messages, retained for
 * moderation. Old clients that still call DELETE get the safe behaviour instead
 * of the destructive one, which is the reason this stayed on the same verb
 * rather than moving to a new route.
 *
 * `reason` defaults to `unmatch`. Blocking closes the conversation through
 * `POST /users/:id/block`, which passes `block` — nothing branches on the value
 * (see the schema comment), it is moderation context.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("heavy", "conversation-mutate", authUser.userId))
    if (limited) return limited

    const conversation = await db.private_conversations.findUnique({
      where: { id: conversationId },
    })

    if (!conversation) {
      return notFoundResponse("Conversation not found")
    }

    // Verify user is part of the conversation
    if (
      conversation.user1_id !== authUser.userId &&
      conversation.user2_id !== authUser.userId
    ) {
      return forbiddenResponse("Not authorized to leave this conversation")
    }

    // Idempotent: closing an already-closed conversation keeps the first close,
    // so a double tap or a client retry never rewrites who left or when.
    await closeConversation(conversationId, authUser.userId, "unmatch")

    /*
     * Evict both sides from the socket room.
     *
     * `canJoinConversation` now refuses a closed conversation, but that only
     * gates *new* joins — anyone already sitting in `conversation:${id}` keeps
     * their subscription until they disconnect, and would go on receiving
     * typing indicators and read receipts from a conversation that has ended.
     */
    closeConversationRoom(conversationId)

    return successResponse({ closed: true })
  } catch (error) {
    logger.error("Close conversation error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to leave conversation")
  }
}
