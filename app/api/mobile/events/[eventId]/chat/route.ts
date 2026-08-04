import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
  ErrorCode,
} from "@/lib/api-response"
import { chatQuerySchema, sendMessageSchema } from "@/lib/validations/chat"
import { generateUniqueAnonymousName } from "@/lib/anonymous-names"
import { moderateMessage, checkSpam } from "@/lib/moderation"
import { checkAndAutoUnmute, hideMessage, flagForReview, checkAndAutoMute } from "@/lib/moderation/actions"
import { checkKeywords } from "@/lib/moderation/keyword-filter"
import { checkTextContent } from "@/lib/moderation/openai-moderation"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Parse query parameters
    const searchParams = Object.fromEntries(request.nextUrl.searchParams)
    const parsed = chatQuerySchema.safeParse(searchParams)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { page, limit, before, after } = parsed.data

    // Get chat group for event (create on demand if user is checked in)
    let chatGroup = await db.chat_groups.findUnique({
      where: { event_id: eventId },
    })

    if (!chatGroup) {
      const checkIn = await db.event_check_ins.findUnique({
        where: {
          event_id_user_id: {
            event_id: eventId,
            user_id: authUser.userId,
          },
        },
        select: { status: true },
      })

      if (checkIn?.status !== "checked_in") {
        return notFoundResponse("Chat not available for this event")
      }

      const event = await db.events.findUnique({
        where: { id: eventId, deleted_at: null },
        select: { title: true },
      })

      chatGroup = await db.chat_groups.create({
        data: {
          event_id: eventId,
          name: `${event?.title || "Event"} Chat`,
          description: `Chat for ${event?.title || "Event"}`,
          status: "active",
          member_count: 0,
        },
      })
    }

    // Check if user is a member of the chat group
    const membership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
    })

    if (!membership || membership.status !== "active") {
      const checkIn = await db.event_check_ins.findUnique({
        where: {
          event_id_user_id: {
            event_id: eventId,
            user_id: authUser.userId,
          },
        },
        select: { status: true },
      })

      if (checkIn?.status !== "checked_in") {
        return forbiddenResponse("You must check in to the event to access chat")
      }

      const anonName = await generateUniqueAnonymousName(chatGroup.id)
      await db.chat_group_members.upsert({
        where: {
          chat_group_id_user_id: {
            chat_group_id: chatGroup.id,
            user_id: authUser.userId,
          },
        },
        create: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
          role: "member",
          status: "active",
          last_allowed_at: null,
          anonymous_name: anonName,
        },
        update: {
          status: "active",
          last_allowed_at: null,
          updated_at: new Date(),
        },
      })

      await db.chat_groups.update({
        where: { id: chatGroup.id },
        data: { member_count: { increment: 1 } },
      })
    }

    const membershipFresh = membership
      ? membership
      : await db.chat_group_members.findUnique({
          where: {
            chat_group_id_user_id: {
              chat_group_id: chatGroup.id,
              user_id: authUser.userId,
            },
          },
        })

    // Build anonymous name map from chat_group_members
    const allMembers = await db.chat_group_members.findMany({
      where: { chat_group_id: chatGroup.id },
      select: { user_id: true, anonymous_name: true },
    })
    const anonMap = new Map(
      allMembers.map((m) => [m.user_id, m.anonymous_name || "Attendee"])
    )

    // Build where clause for messages — include moderation-hidden messages
    // for the sender so they see "This message was removed" placeholders
    const where: Record<string, unknown> = {
      chat_group_id: chatGroup.id,
      OR: [
        { deleted_at: null },
        { moderation_status: "hidden", user_id: authUser.userId },
      ],
    }

    if (membershipFresh?.last_allowed_at) {
      where.created_at = { lte: membershipFresh.last_allowed_at }
    }

    if (before) {
      where.created_at = { ...(where.created_at || {}), lt: new Date(before) }
    }
    if (after) {
      where.created_at = { ...(where.created_at || {}), gt: new Date(after) }
    }

    // Get total count
    const totalCount = await db.chat_messages.count({ where })

    // Fetch messages with user info
    const messages = await db.chat_messages.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        reactions: {
          include: {
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
      skip: (page - 1) * limit,
      take: limit,
    })

    // Update last read message for user
    if (messages.length > 0) {
      await db.chat_group_members.update({
        where: {
          chat_group_id_user_id: {
            chat_group_id: chatGroup.id,
            user_id: authUser.userId,
          },
        },
        data: {
          last_read_message_id: messages[0].id,
          updated_at: new Date(),
        },
      })
    }

    return successResponse({
      chatGroupId: chatGroup.id,
      chatGroupName: chatGroup.name,
      messages: messages.reverse().map((m) => {
        const isHidden = m.moderation_status === "hidden"
        return {
          id: m.id,
          type: m.type,
          content: isHidden ? null : m.content,
          moderation_hidden: isHidden,
          metadata: isHidden ? null : m.metadata,
          isEdited: m.is_edited,
          isPinned: m.is_pinned,
          createdAt: m.created_at,
          editedAt: m.edited_at,
          parentId: m.parent_id,
          replyCount: m._count.replies,
          user: {
            id: m.user.id,
            name: anonMap.get(m.user.id) || "Attendee",
            image: null,
          },
          reactions: isHidden ? [] : m.reactions.map((r) => ({
            emoji: r.emoji,
            userId: r.user_id,
            userName: anonMap.get(r.user_id) || "Attendee",
          })),
          isOwn: m.user_id === authUser.userId,
        }
      }),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
    })
  } catch (error) {
    logger.error("Get chat messages error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get messages")
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const body = await request.json()

    // Validate input
    const parsed = sendMessageSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { content, type, parentId, metadata } = parsed.data

    // Get chat group for event (create on demand if user is checked in)
    let chatGroup = await db.chat_groups.findUnique({
      where: { event_id: eventId },
    })

    if (!chatGroup) {
      const checkIn = await db.event_check_ins.findUnique({
        where: {
          event_id_user_id: {
            event_id: eventId,
            user_id: authUser.userId,
          },
        },
        select: { status: true },
      })

      if (checkIn?.status !== "checked_in") {
        return notFoundResponse("Chat not available for this event")
      }

      const event = await db.events.findUnique({
        where: { id: eventId, deleted_at: null },
        select: { title: true },
      })

      chatGroup = await db.chat_groups.create({
        data: {
          event_id: eventId,
          name: `${event?.title || "Event"} Chat`,
          description: `Chat for ${event?.title || "Event"}`,
          status: "active",
          member_count: 0,
        },
      })
    }

    // Check if chat group is active
    if (chatGroup.status !== "active") {
      return forbiddenResponse("This chat is no longer active")
    }

    // Check if user is a member of the chat group
    const membership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
    })

    // Check muted/banned BEFORE auto-join logic — do not re-activate restricted users
    if (membership?.status === "muted") {
      // Check if the auto-mute window has expired (1 hour)
      const wasUnmuted = await checkAndAutoUnmute(authUser.userId, chatGroup.id)
      if (!wasUnmuted) {
        return errorResponse(
          "You are muted in this chat. Your messages have been flagged for policy violations.",
          403,
          ErrorCode.USER_MUTED
        )
      }
      // User was auto-unmuted, proceed with sending
    }
    if (membership?.status === "banned") {
      return errorResponse(
        "You have been banned from this chat due to repeated policy violations.",
        403,
        ErrorCode.USER_BANNED
      )
    }

    // Auto-join: if not a member yet, check if user is checked in
    if (!membership) {
      const checkIn = await db.event_check_ins.findUnique({
        where: {
          event_id_user_id: {
            event_id: eventId,
            user_id: authUser.userId,
          },
        },
        select: { status: true },
      })

      if (checkIn?.status !== "checked_in") {
        return errorResponse(
          "You must check in to the event to send messages",
          403,
          ErrorCode.NOT_CHECKED_IN
        )
      }

      const postAnonName = await generateUniqueAnonymousName(chatGroup.id)
      await db.chat_group_members.create({
        data: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
          role: "member",
          status: "active",
          last_allowed_at: null,
          anonymous_name: postAnonName,
        },
      })

      await db.chat_groups.update({
        where: { id: chatGroup.id },
        data: { member_count: { increment: 1 } },
      })
    }

    const membershipFresh = membership
      ? membership
      : await db.chat_group_members.findUnique({
          where: {
            chat_group_id_user_id: {
              chat_group_id: chatGroup.id,
              user_id: authUser.userId,
            },
          },
        })

    if (membershipFresh?.last_allowed_at) {
      return errorResponse(
        "You must be checked in to send messages",
        403,
        ErrorCode.NOT_CHECKED_IN
      )
    }

    // If replying, verify parent message exists
    if (parentId) {
      const parentMessage = await db.chat_messages.findUnique({
        where: { id: parentId, chat_group_id: chatGroup.id },
      })
      if (!parentMessage) {
        return notFoundResponse("Parent message not found")
      }
    }

    // Spam check (sync — block before saving)
    const spamResult = checkSpam(authUser.userId, chatGroup.id, content)
    if (spamResult && spamResult.action === "hide") {
      return errorResponse(
        spamResult.reason || "Message blocked as spam. Please slow down.",
        429,
        ErrorCode.SPAM_BLOCKED
      )
    }

    // --- Pre-save moderation: keyword filter (sync, <1ms) ---
    const keywordResult = checkKeywords(content)
    if (keywordResult && keywordResult.action === "hide") {
      // Save but immediately mark as hidden — never emitted to other users
      const message = await db.chat_messages.create({
        data: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
          content,
          type,
          parent_id: parentId,
          metadata: metadata as Prisma.InputJsonValue | undefined,
          moderation_status: "hidden",
          deleted_at: new Date(),
        },
      })
      void flagForReview(message.id, chatGroup.id, authUser.userId, keywordResult)
      void checkAndAutoMute(authUser.userId, chatGroup.id)
      return successResponse({
        message: {
          id: message.id,
          type: message.type,
          content: null,
          moderation_hidden: true,
          createdAt: message.created_at,
        },
      })
    }

    // Create message
    const message = await db.chat_messages.create({
      data: {
        chat_group_id: chatGroup.id,
        user_id: authUser.userId,
        content,
        type,
        parent_id: parentId,
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    })

    // --- Pre-emit moderation: OpenAI check with 1s timeout ---
    if (type === "text") {
      try {
        const openaiResult = await Promise.race([
          checkTextContent(content),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
        ])
        if (openaiResult && openaiResult.action === "hide") {
          await hideMessage(message.id, chatGroup.id, authUser.userId, openaiResult)
          await flagForReview(message.id, chatGroup.id, authUser.userId, openaiResult)
          void checkAndAutoMute(authUser.userId, chatGroup.id)
          return successResponse({
            message: {
              id: message.id,
              type: message.type,
              content: null,
              moderation_hidden: true,
              createdAt: message.created_at,
            },
          })
        }
        if (openaiResult && openaiResult.action === "flag") {
          void flagForReview(message.id, chatGroup.id, authUser.userId, openaiResult)
        }
        // Timeout fallback — run full async pipeline
        if (!openaiResult && content.length > 5) {
          void moderateMessage(message.id, content, type, authUser.userId, chatGroup.id)
        }
      } catch {
        void moderateMessage(message.id, content, type, authUser.userId, chatGroup.id)
      }
    } else {
      void moderateMessage(
        message.id,
        content,
        type,
        authUser.userId,
        chatGroup.id,
        (metadata as Record<string, string> | undefined)?.mediaUrl
      )
    }

    // Mark clean if passed all checks
    if (!message.moderation_status || message.moderation_status === "pending") {
      void db.chat_messages.update({
        where: { id: message.id },
        data: { moderation_status: "clean" },
      }).catch((err: unknown) =>
      // Push is best-effort and must not fail the request, but swallowing the
      // error entirely means a broken push pipeline is invisible.
      logger.warn("Push notification failed", {
        context: "event chat message",
        error: err instanceof Error ? err.message : String(err),
      })
    )
    }

    // Get anonymous name for response
    const senderMembership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
      select: { anonymous_name: true },
    })

    // Update chat group last_message_at
    await db.chat_groups.update({
      where: { id: chatGroup.id },
      data: {
        last_message_at: new Date(),
        updated_at: new Date(),
      },
    })

    return successResponse(
      {
        message: {
          id: message.id,
          type: message.type,
          content: message.content,
          metadata: message.metadata,
          createdAt: message.created_at,
          parentId: message.parent_id,
          user: {
            id: authUser.userId,
            name: senderMembership?.anonymous_name || "Attendee",
            image: null,
          },
          reactions: [],
          isOwn: true,
        },
      },
      201
    )
  } catch (error) {
    logger.error("Send message error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send message")
  }
}
