import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { z } from "zod"

const createConversationSchema = z.object({
  otherUserId: z.string().min(1, "Other user ID is required"),
})

// GET /api/mobile/conversations - List user's conversations
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const conversations = await db.private_conversations.findMany({
      where: {
        OR: [
          { user1_id: authUser.userId },
          { user2_id: authUser.userId },
        ],
      },
      include: {
        user1: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        user2: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        messages: {
          orderBy: { created_at: "desc" },
          take: 1,
          select: {
            id: true,
            message_text: true,
            sender_id: true,
            created_at: true,
            is_read: true,
          },
        },
        _count: {
          select: {
            messages: {
              where: {
                is_read: false,
                sender_id: { not: authUser.userId },
              },
            },
          },
        },
      },
      orderBy: {
        last_message_at: "desc",
      },
    })

    // Format conversations for the mobile app
    const formattedConversations = conversations.map((conv) => {
      const otherUser = conv.user1_id === authUser.userId ? conv.user2 : conv.user1
      const lastMessage = conv.messages[0] || null

      return {
        id: conv.id,
        otherUser: {
          id: otherUser.id,
          name: otherUser.name,
          image: otherUser.image,
        },
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              text: lastMessage.message_text,
              senderId: lastMessage.sender_id,
              createdAt: lastMessage.created_at,
              isRead: lastMessage.is_read,
            }
          : null,
        unreadCount: conv._count.messages,
        updatedAt: conv.last_message_at || conv.created_at,
      }
    })

    return successResponse(formattedConversations)
  } catch (error) {
    logger.error("List conversations error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to list conversations")
  }
}

// POST /api/mobile/conversations - Create or get existing conversation
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("heavy", "conversation-create", authUser.userId))
    if (limited) return limited

    const body = await request.json()
    const parsed = createConversationSchema.safeParse(body)

    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { otherUserId } = parsed.data

    // Can't create conversation with yourself
    if (otherUserId === authUser.userId) {
      return errorResponse("Cannot create conversation with yourself")
    }

    // Check if other user exists
    const otherUser = await db.user.findUnique({
      where: { id: otherUserId },
      select: { id: true, name: true, image: true },
    })

    if (!otherUser) {
      return notFoundResponse("User not found")
    }

    // Sort user IDs to ensure consistent lookup (user1_id < user2_id)
    const [user1Id, user2Id] = [authUser.userId, otherUserId].sort()

    // Find or create conversation
    let conversation = await db.private_conversations.findUnique({
      where: {
        user1_id_user2_id: {
          user1_id: user1Id,
          user2_id: user2Id,
        },
      },
      include: {
        user1: { select: { id: true, name: true, image: true } },
        user2: { select: { id: true, name: true, image: true } },
      },
    })

    if (!conversation) {
      conversation = await db.private_conversations.create({
        data: {
          user1_id: user1Id,
          user2_id: user2Id,
        },
        include: {
          user1: { select: { id: true, name: true, image: true } },
          user2: { select: { id: true, name: true, image: true } },
        },
      })
    }

    const conversationOtherUser =
      conversation.user1_id === authUser.userId
        ? conversation.user2
        : conversation.user1

    return successResponse({
      id: conversation.id,
      otherUser: conversationOtherUser,
      createdAt: conversation.created_at,
      isNew: !conversation.last_message_at,
    })
  } catch (error) {
    logger.error("Create conversation error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to create conversation")
  }
}
