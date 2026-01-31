import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
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

    const otherUser =
      conversation.user1_id === authUser.userId
        ? conversation.user2
        : conversation.user1

    return successResponse({
      id: conversation.id,
      otherUser,
      createdAt: conversation.created_at,
      lastMessageAt: conversation.last_message_at,
    })
  } catch (error) {
    console.error("Get conversation error:", error)
    return serverErrorResponse("Failed to get conversation")
  }
}

// DELETE /api/mobile/conversations/[conversationId] - Delete conversation
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

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
      return forbiddenResponse("Not authorized to delete this conversation")
    }

    // Delete conversation (messages will cascade delete)
    await db.private_conversations.delete({
      where: { id: conversationId },
    })

    return successResponse({ deleted: true })
  } catch (error) {
    console.error("Delete conversation error:", error)
    return serverErrorResponse("Failed to delete conversation")
  }
}
