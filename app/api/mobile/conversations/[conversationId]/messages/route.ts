import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { blockedEitherWay } from "@/lib/conversations"
import { db } from "@/lib/db"
import { media_type } from "@prisma/client"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, createUserRateLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  ErrorCode,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { z } from "zod"
import { displayNameInConversation, mayShowRealName } from "@/lib/conversation-identity"
import { screenDirectMessage, VISIBLE_DM } from "@/lib/dm-moderation"
import { emitPrivateMessage } from "@/lib/socket-server"
import { notifyPrivateMessage } from "@/lib/push-notifications"

interface RouteParams {
  params: Promise<{ conversationId: string }>
}

const sendMessageSchema = z.object({
  text: z.string().min(1).max(5000).optional(),
  mediaUrl: z.string().url().optional(),
  mediaType: z.enum(["image", "video"]).optional(),
}).refine(
  (data) => data.text || data.mediaUrl,
  { message: "Message must have text or media" }
)

// GET /api/mobile/conversations/[conversationId]/messages - Get messages
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100)
    const before = searchParams.get("before") // cursor for pagination

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Verify conversation exists and user has access
    const conversation = await db.private_conversations.findUnique({
      where: { id: conversationId },
    })

    if (!conversation) {
      return notFoundResponse("Conversation not found")
    }

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

    // Build query
    /*
     * `VISIBLE_DM` excludes a message the deterministic checks hid. It is
     * excluded for the sender too, which is the same answer the group route
     * gives: a hidden message is stored as evidence for a later report, not
     * kept readable by the person who sent it.
     */
    const whereClause: Record<string, unknown> = {
      conversation_id: conversationId,
      ...VISIBLE_DM,
    }
    if (before) {
      whereClause.created_at = { lt: new Date(before) }
    }

    const messages = await db.private_messages.findMany({
      where: whereClause,
      orderBy: { created_at: "desc" },
      take: limit,
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    })

    // Mark unread messages as read
    const unreadMessageIds = messages
      .filter((m) => !m.is_read && m.sender_id !== authUser.userId)
      .map((m) => m.id)

    if (unreadMessageIds.length > 0) {
      await db.private_messages.updateMany({
        where: { id: { in: unreadMessageIds } },
        data: { is_read: true },
      })
    }

    // Format for mobile app
    const formattedMessages = messages.map((msg) => ({
      id: msg.id,
      conversationId: msg.conversation_id,
      senderId: msg.sender_id,
      // The pseudonym holds on every message, not just the header.
      sender: {
        ...msg.sender,
        name: displayNameInConversation(conversation, msg.sender.id, msg.sender.name),
        image: mayShowRealName(conversation, msg.sender.id) ? msg.sender.image : null,
      },
      text: msg.message_text,
      mediaUrl: msg.media_url,
      mediaType: msg.media_type,
      isRead: msg.is_read,
      createdAt: msg.created_at,
    }))

    return successResponse({
      messages: formattedMessages,
      hasMore: messages.length === limit,
      nextCursor: messages.length > 0 ? messages[messages.length - 1].created_at.toISOString() : null,
    })
  } catch (error) {
    logger.error("Get messages error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get messages")
  }
}

// POST /api/mobile/conversations/[conversationId]/messages - Send message
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const body = await request.json()
    const parsed = sendMessageSchema.safeParse(body)

    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { text, mediaUrl, mediaType } = parsed.data

    // Verify conversation exists and user has access
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

    if (
      conversation.user1_id !== authUser.userId &&
      conversation.user2_id !== authUser.userId
    ) {
      return forbiddenResponse("Not authorized to send messages to this conversation")
    }

    // Closed conversations are gone for both people. Retained for moderation,
    // not readable by the participants -- see lib/conversations.ts.
    if (conversation.closed_at) {
      return notFoundResponse("Conversation not found")
    }

    // Group chat sends and check-ins are rate limited; DM sends were not, so a
    // single account could flood a conversation and its push notifications.
    const limited = await rateLimit(request, createUserRateLimit("private-message", authUser.userId))
    if (limited) return limited

    // Check if the recipient has blocked the sender
    const recipientId =
      conversation.user1_id === authUser.userId
        ? conversation.user2_id
        : conversation.user1_id

    /*
     * Both directions. This only asked whether the recipient had blocked the
     * sender, so someone who had blocked the other person could still message
     * them — which is not what "block" means to either party, and leaves the
     * blocker receiving replies from a person they have chosen not to hear from.
     */
    if (await blockedEitherWay(authUser.userId, recipientId)) {
      // Deliberately does not say which direction the block runs in.
      return forbiddenResponse("You cannot send messages to this user")
    }

    /*
     * The deterministic checks, which this path had none of.
     *
     * `lib/moderation` was imported by exactly two files and both were group
     * chat, so a DM got no keyword check, no spam check and no contact-info
     * check — in the one channel where somebody is alone with a stranger, and
     * the one `contact-info.ts` names as where the harm it targets lands.
     *
     * No model, deliberately (TR5): a model check sends an unreviewed private
     * message to a third party and, on a hit, turns it into something a human
     * may read. Nothing here is read by anybody unless it is reported.
     */
    const screen = await screenDirectMessage({
      senderId: authUser.userId,
      conversationId,
      text,
    })
    if (screen.verdict === "refuse") {
      return errorResponse(screen.reason, 429, ErrorCode.SPAM_BLOCKED)
    }
    const hidden = screen.verdict === "hide"

    // Create the message
    const message = await db.private_messages.create({
      data: {
        conversation_id: conversationId,
        sender_id: authUser.userId,
        message_text: text,
        // Both optional in the schema, so undefined whenever a text-only DM is
        // sent — which is every DM. Explicit undefined threw under
        // `strictUndefinedChecks`, so sending a DM returned 500. Found by
        // sending one from the simulator after a match.
        ...(mediaUrl != null && { media_url: mediaUrl }),
        ...(mediaType != null && { media_type: mediaType as media_type }),
        moderation_status: screen.status,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    })

    /*
     * A hidden message does not touch the conversation's clock.
     *
     * `last_message_at` drives the inbox ordering and the "new message" dot, so
     * bumping it would surface a thread the recipient has nothing to read in —
     * telling them somebody wrote, which is most of what the sender wanted.
     */
    if (!hidden) {
      await db.private_conversations.update({
        where: { id: conversationId },
        data: { last_message_at: new Date(), updated_at: new Date() },
      })
    }

    // Emit via Socket.io
    const messageData = {
      id: message.id,
      conversationId: message.conversation_id,
      senderId: message.sender_id,
      sender: {
        ...message.sender,
        name: displayNameInConversation(conversation, message.sender.id, message.sender.name),
        image: mayShowRealName(conversation, message.sender.id) ? message.sender.image : null,
      },
      text: message.message_text,
      mediaUrl: message.media_url,
      mediaType: message.media_type,
      isRead: message.is_read,
      createdAt: message.created_at,
    }

    /*
     * Neither delivered nor announced.
     *
     * The row exists so a later report has something to rest on —
     * `moderation_flags.message_id` is a NOT NULL foreign key to
     * `chat_messages`, so a flag against a DM is structurally impossible and
     * the message itself is the only record. It is stored, and it is not sent.
     */
    if (!hidden) {
      emitPrivateMessage(conversationId, recipientId, messageData)
    }

    /*
     * The push TITLE, resolved through the conversation.
     *
     * This was `message.sender.name`, so a lock screen would carry the real
     * name of someone the recipient only knows by a pseudonym -- and a lock
     * screen is not an authenticated surface. Unchanged for conversations that
     * were never pseudonymous, which is all of them until the reveal work
     * lands.
     */
    const senderName = displayNameInConversation(
      conversation,
      authUser.userId,
      message.sender.name
    )
    const messagePreview = text || (mediaType === "image" ? "📷 Photo" : "🎥 Video")
    if (!hidden) {
      notifyPrivateMessage(recipientId, senderName, messagePreview, conversationId).catch((err) =>
        logger.error("Push notification failed", { error: err instanceof Error ? err.message : String(err) })
      )
    }

    /*
     * The sender is told, rather than left to conclude they were ignored.
     *
     * Same shape as the group route's `moderation_hidden`, and the same
     * argument: a silent drop teaches nothing and reads as the recipient not
     * replying, which is worse for the person who was not at fault.
     */
    if (hidden) {
      return successResponse({ ...messageData, text: null, moderation_hidden: true })
    }

    return successResponse(messageData)
  } catch (error) {
    logger.error("Send message error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send message")
  }
}
