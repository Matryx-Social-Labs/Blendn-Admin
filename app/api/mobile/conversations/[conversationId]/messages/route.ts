import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { z } from "zod"
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
    const page = parseInt(searchParams.get("page") || "1")
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

    // Build query
    const whereClause: any = { conversation_id: conversationId }
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
      sender: msg.sender,
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
    console.error("Get messages error:", error)
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

    // Get sender info
    const sender = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { id: true, name: true, image: true },
    })

    // Create the message
    const message = await db.private_messages.create({
      data: {
        conversation_id: conversationId,
        sender_id: authUser.userId,
        message_text: text,
        media_url: mediaUrl,
        media_type: mediaType as any,
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

    // Update conversation's last message time
    await db.private_conversations.update({
      where: { id: conversationId },
      data: { last_message_at: new Date(), updated_at: new Date() },
    })

    // Determine recipient
    const recipientId =
      conversation.user1_id === authUser.userId
        ? conversation.user2_id
        : conversation.user1_id

    // Emit via Socket.io
    const messageData = {
      id: message.id,
      conversationId: message.conversation_id,
      senderId: message.sender_id,
      sender: message.sender,
      text: message.message_text,
      mediaUrl: message.media_url,
      mediaType: message.media_type,
      isRead: message.is_read,
      createdAt: message.created_at,
    }

    emitPrivateMessage(conversationId, recipientId, messageData)

    // Send push notification to recipient (async, don't await)
    const senderName = message.sender.name || "Someone"
    const messagePreview = text || (mediaType === "image" ? "📷 Photo" : "🎥 Video")
    notifyPrivateMessage(recipientId, senderName, messagePreview, conversationId).catch((err) =>
      console.error("Push notification failed:", err)
    )

    return successResponse(messageData)
  } catch (error) {
    console.error("Send message error:", error)
    return serverErrorResponse("Failed to send message")
  }
}
