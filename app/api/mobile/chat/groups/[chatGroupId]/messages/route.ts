import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import { emitChatMessage } from "@/lib/socket-server"
import { notifyGroupMessage } from "@/lib/push-notifications"
import { rateLimit } from "@/lib/rate-limit"
import { moderateMessage, checkSpam } from "@/lib/moderation"
import { checkAndAutoUnmute } from "@/lib/moderation/actions"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  validationErrorResponse,
  serverErrorResponse,
  ErrorCode,
} from "@/lib/api-response"

const sendMessageSchema = z.object({
  content: z.string().min(1, "Message content is required").max(4000),
  type: z.enum(["text", "image", "video"]).default("text"),
  metadata: z.record(z.any()).optional(),
  parentId: z.string().uuid().optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chatGroupId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const { chatGroupId } = await params
    const { searchParams } = new URL(request.url)

    // Validate chatGroupId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(chatGroupId)) {
      return errorResponse("Invalid chat group ID format", 400)
    }

    // Pagination params
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100)
    const before = searchParams.get("before") // cursor for pagination

    // Check if chat group exists and user is a member
    const chatGroup = await db.chat_groups.findUnique({
      where: { id: chatGroupId },
      include: {
        members: {
          where: { user_id: user.userId },
        },
      },
    })

    if (!chatGroup) {
      return notFoundResponse("Chat group not found")
    }

    // Check if user is a member
    const isMember = chatGroup.members.length > 0
    if (!isMember) {
      return forbiddenResponse("You are not a member of this chat group")
    }

    // Build anonymous name map
    const allMembers = await db.chat_group_members.findMany({
      where: { chat_group_id: chatGroupId },
      select: { user_id: true, anonymous_name: true },
    })
    const anonMap = new Map(
      allMembers.map((m) => [m.user_id, m.anonymous_name || "Attendee"])
    )

    // Build query for messages — include moderation-hidden messages
    // so the sender can see "This message was removed" placeholders
    const whereClause: Record<string, unknown> = {
      chat_group_id: chatGroupId,
      OR: [
        { deleted_at: null },
        { moderation_status: "hidden", user_id: user.userId },
      ],
    }

    // If cursor provided, get messages before that message
    if (before) {
      const cursorMessage = await db.chat_messages.findUnique({
        where: { id: before },
        select: { created_at: true },
      })

      if (cursorMessage) {
        whereClause.created_at = { lt: cursorMessage.created_at }
      }
    }

    // Fetch messages
    const messages = await db.chat_messages.findMany({
      where: whereClause,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        reactions: {
          select: {
            id: true,
            emoji: true,
            user_id: true,
          },
        },
        parent_message: {
          select: {
            id: true,
            content: true,
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        _count: {
          select: {
            replies: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
      take: limit + 1, // Fetch one extra to check if there are more
    })

    // Check if there are more messages
    const hasMore = messages.length > limit
    const messagesToReturn = hasMore ? messages.slice(0, limit) : messages

    // Reverse to get chronological order (oldest first within the batch)
    messagesToReturn.reverse()

    return successResponse({
      messages: messagesToReturn.map((m) => {
        const isHidden = m.moderation_status === "hidden"
        return {
          ...m,
          // Redact content for moderation-hidden messages; show placeholder
          content: isHidden ? null : m.content,
          moderation_hidden: isHidden,
          user: {
            id: m.user.id,
            name: anonMap.get(m.user.id) || "Attendee",
            image: null,
          },
          parent_message: m.parent_message
            ? {
                ...m.parent_message,
                user: {
                  id: m.parent_message.user.id,
                  name: anonMap.get(m.parent_message.user.id) || "Attendee",
                },
              }
            : null,
        }
      }),
      pagination: {
        hasMore,
        nextCursor: hasMore ? messagesToReturn[0]?.id : null,
      },
    })
  } catch (error) {
    console.error("Get chat messages error:", error)
    return serverErrorResponse("Failed to get messages")
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chatGroupId: string }> }
) {
  // Rate limit: max 30 messages per user per minute per group
  const rateLimited = rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 30,
    keyGenerator: (req) => {
      const auth = req.headers.get("authorization") || "anon"
      const url = req.nextUrl.pathname
      return `groupmsg:${auth.slice(-16)}:${url}`
    },
  })
  if (rateLimited) return rateLimited

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const { chatGroupId } = await params

    // Validate chatGroupId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(chatGroupId)) {
      return errorResponse("Invalid chat group ID format", 400)
    }

    const body = await request.json()

    // Validate request body
    const validation = sendMessageSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { content, type, metadata, parentId } = validation.data

    // Check if chat group exists and user is a member
    const chatGroup = await db.chat_groups.findUnique({
      where: { id: chatGroupId },
      include: {
        members: {
          where: { user_id: user.userId },
        },
      },
    })

    if (!chatGroup) {
      return notFoundResponse("Chat group not found")
    }

    // Check if user is a member
    const membership = chatGroup.members[0]
    if (!membership) {
      return forbiddenResponse("You are not a member of this chat group")
    }

    // Check if user is muted or banned
    if (membership.status === "muted") {
      // Check if the auto-mute window has expired (1 hour)
      const wasUnmuted = await checkAndAutoUnmute(user.userId, chatGroupId)
      if (!wasUnmuted) {
        return errorResponse(
          "You are muted in this chat group. Your messages have been flagged for policy violations.",
          403,
          ErrorCode.USER_MUTED
        )
      }
      // User was auto-unmuted, proceed with sending
    }
    if (membership.status === "banned") {
      return errorResponse(
        "You have been banned from this chat group due to repeated policy violations.",
        403,
        ErrorCode.USER_BANNED
      )
    }

    // Enforce chat access cutoff — users lose write access when they check out
    if (membership.last_allowed_at && membership.last_allowed_at < new Date()) {
      return errorResponse(
        "You must be checked in to send messages in this event chat",
        403,
        ErrorCode.NOT_CHECKED_IN
      )
    }

    // Check if chat group is locked
    if (chatGroup.status === "locked") {
      return errorResponse(
        "This chat group is currently locked by the organiser",
        403,
        ErrorCode.CHAT_LOCKED
      )
    }

    // If replying, verify parent message exists in this group
    if (parentId) {
      const parentMessage = await db.chat_messages.findFirst({
        where: {
          id: parentId,
          chat_group_id: chatGroupId,
          deleted_at: null,
        },
      })

      if (!parentMessage) {
        return errorResponse("Parent message not found", 400)
      }
    }

    // Spam check (sync — block before saving)
    const spamResult = checkSpam(user.userId, chatGroupId, content)
    if (spamResult && spamResult.action === "hide") {
      return errorResponse(
        spamResult.reason || "Message blocked as spam. Please slow down.",
        429,
        ErrorCode.SPAM_BLOCKED
      )
    }

    // Create the message
    const message = await db.chat_messages.create({
      data: {
        chat_group_id: chatGroupId,
        user_id: user.userId,
        content,
        type,
        metadata: metadata || undefined,
        parent_id: parentId || null,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        parent_message: {
          select: {
            id: true,
            content: true,
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    })

    // Update chat group's last_message_at
    await db.chat_groups.update({
      where: { id: chatGroupId },
      data: { last_message_at: new Date() },
    })

    // Use anonymous name for socket emit and push
    const senderAnonName = membership.anonymous_name || "Attendee"

    // Emit real-time message (anonymous)
    emitChatMessage(chatGroupId, {
      id: message.id,
      content: message.content,
      type: message.type,
      userId: message.user_id,
      userName: senderAnonName,
      userImage: undefined,
      createdAt: message.created_at.toISOString(),
      parentId: message.parent_id || undefined,
    })

    // Fire-and-forget: async content moderation
    void moderateMessage(
      message.id,
      content,
      type,
      user.userId,
      chatGroupId,
      (metadata as Record<string, string> | undefined)?.mediaUrl
    )

    // Send push notifications to group members (async, don't await)
    db.chat_group_members
      .findMany({
        where: { chat_group_id: chatGroupId, status: "active" },
        select: { user_id: true },
      })
      .then((members) => {
        const memberIds = members.map((m) => m.user_id)
        const groupName = chatGroup.name || "Group Chat"
        const messagePreview = type === "text" ? content : type === "image" ? "📷 Photo" : "🎥 Video"

        return notifyGroupMessage(memberIds, senderAnonName, groupName, messagePreview, chatGroupId, user.userId)
      })
      .catch((err) => console.error("Push notification failed:", err))

    // Return anonymized response
    return successResponse({
      ...message,
      user: {
        id: message.user.id,
        name: senderAnonName,
        image: null,
      },
      parent_message: message.parent_message
        ? {
            ...message.parent_message,
            user: {
              id: message.parent_message.user.id,
              name: membership.anonymous_name || "Attendee",
            },
          }
        : null,
    }, 201)
  } catch (error) {
    console.error("Send message error:", error)
    return serverErrorResponse("Failed to send message")
  }
}
