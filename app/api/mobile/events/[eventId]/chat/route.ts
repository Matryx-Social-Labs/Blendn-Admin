import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { chatQuerySchema, sendMessageSchema } from "@/lib/validations/chat"
import { generateUniqueAnonymousName } from "@/lib/anonymous-names"

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

    // Build where clause for messages (lock to last checkout time if not checked in)
    const where: Record<string, unknown> = {
      chat_group_id: chatGroup.id,
      deleted_at: null,
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
      messages: messages.reverse().map((m) => ({
        id: m.id,
        type: m.type,
        content: m.content,
        metadata: m.metadata,
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
        reactions: m.reactions.map((r) => ({
          emoji: r.emoji,
          userId: r.user_id,
          userName: anonMap.get(r.user_id) || "Attendee",
        })),
        isOwn: m.user_id === authUser.userId,
      })),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
    })
  } catch (error) {
    console.error("Get chat messages error:", error)
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
        return forbiddenResponse("You must check in to the event to send messages")
      }

      const postAnonName = await generateUniqueAnonymousName(chatGroup.id)
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
          anonymous_name: postAnonName,
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

    if (membershipFresh?.last_allowed_at) {
      return forbiddenResponse("You must check in to send messages")
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
    console.error("Send message error:", error)
    return serverErrorResponse("Failed to send message")
  }
}
