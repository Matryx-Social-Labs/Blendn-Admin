import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Fix #21: Archive chat groups whose event ended more than 24 hours ago.
    // Runs in the background — doesn't block the response.
    const archiveCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    db.chat_groups.updateMany({
      where: {
        status: "active",
        event: {
          end_time: { lt: archiveCutoff },
        },
      },
      data: { status: "archived" },
    }).catch((err: unknown) => console.error("Auto-archive chat groups failed:", err))

    // Parse pagination params
    const searchParams = request.nextUrl.searchParams
    const page = parseInt(searchParams.get("page") || "1")
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 100)

    // Get total count of user's chat groups
    const totalCount = await db.chat_group_members.count({
      where: {
        user_id: authUser.userId,
        status: "active",
        chat_group: {
          status: "active",
        },
      },
    })

    // Fetch user's chat group memberships with chat group and event details
    const memberships = await db.chat_group_members.findMany({
      where: {
        user_id: authUser.userId,
        status: "active",
        chat_group: {
          status: "active",
        },
      },
      include: {
        chat_group: {
          include: {
            event: {
              select: {
                id: true,
                slug: true,
                title: true,
                cover_image_url: true,
                start_time: true,
                end_time: true,
                status: true,
              },
            },
            _count: {
              select: {
                messages: {
                  where: { deleted_at: null },
                },
                members: {
                  where: { status: "active" },
                },
              },
            },
          },
        },
      },
      orderBy: {
        chat_group: {
          last_message_at: "desc",
        },
      },
      skip: (page - 1) * limit,
      take: limit,
    })

    // Batch fetch all data in 3 queries instead of N*3 queries
    const chatGroupIds = memberships.map((m) => m.chat_group_id)

    // 1. Batch fetch last read messages (single query)
    const lastReadMessageIds = memberships
      .filter((m) => m.last_read_message_id)
      .map((m) => m.last_read_message_id!)

    const lastReadMessages =
      lastReadMessageIds.length > 0
        ? await db.chat_messages.findMany({
            where: { id: { in: lastReadMessageIds } },
            select: { id: true, created_at: true },
          })
        : []

    const lastReadMessageMap = new Map(
      lastReadMessages.map((m) => [m.id, m.created_at])
    )

    // 2. Batch fetch last message per group using raw SQL (single query)
    type LastMessageRow = {
      id: string
      chat_group_id: string
      content: string
      type: string
      created_at: Date
      user_id: string
      user_name: string | null
    }

    const lastMessagesRaw: LastMessageRow[] = chatGroupIds.length > 0
      ? await db.$queryRaw<LastMessageRow[]>`
          SELECT DISTINCT ON (cm.chat_group_id)
            cm.id, cm.chat_group_id, cm.content, cm.type, cm.created_at, cm.user_id,
            cgm.anonymous_name as user_name
          FROM chat_messages cm
          LEFT JOIN chat_group_members cgm
            ON cm.user_id = cgm.user_id AND cm.chat_group_id = cgm.chat_group_id
          WHERE cm.chat_group_id = ANY(${chatGroupIds}::uuid[])
            AND cm.deleted_at IS NULL
          ORDER BY cm.chat_group_id, cm.created_at DESC
        `
      : []

    const lastMessageMap = new Map(
      lastMessagesRaw.map((m) => [m.chat_group_id, m])
    )

    // 3. Batch calculate unread counts (single query)
    // Build membership data for unread calculation
    const membershipData = memberships.map((m) => ({
      chatGroupId: m.chat_group_id,
      lastReadAt: m.last_read_message_id
        ? lastReadMessageMap.get(m.last_read_message_id)
        : null,
      totalMessages: m.chat_group._count.messages,
    }))

    // For groups with last_read_message_id, count messages after that timestamp
    const groupsWithLastRead = membershipData.filter((m) => m.lastReadAt)

    const unreadCountMap = new Map<string, number>()

    if (groupsWithLastRead.length > 0) {
      // Build parameterized SQL conditions for each group
      const conditions = groupsWithLastRead.map((m) =>
        Prisma.sql`(chat_group_id = ${m.chatGroupId}::uuid AND created_at > ${m.lastReadAt!}::timestamptz)`
      )

      const unreadCountsRaw = await db.$queryRaw<
        Array<{ chat_group_id: string; unread_count: bigint }>
      >`
        SELECT chat_group_id, COUNT(*) as unread_count
        FROM chat_messages
        WHERE deleted_at IS NULL
          AND (${Prisma.join(conditions, " OR ")})
        GROUP BY chat_group_id
      `

      unreadCountsRaw.forEach((row) => {
        unreadCountMap.set(row.chat_group_id, Number(row.unread_count))
      })
    }

    // Build final response
    const groupsWithUnread = memberships.map((membership) => {
      const lastReadAt = membership.last_read_message_id
        ? lastReadMessageMap.get(membership.last_read_message_id)
        : null

      // Calculate unread count
      let unreadCount: number
      if (lastReadAt) {
        unreadCount = unreadCountMap.get(membership.chat_group_id) || 0
      } else {
        // User hasn't read any messages, count all
        unreadCount = membership.chat_group._count.messages
      }

      const lastMessage = lastMessageMap.get(membership.chat_group_id)

      return {
        id: membership.chat_group.id,
        name: membership.chat_group.name,
        type: membership.chat_group.type,
        memberCount: membership.chat_group._count.members,
        unreadCount,
        lastMessageAt: membership.chat_group.last_message_at,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              content:
                lastMessage.type === "text"
                  ? lastMessage.content.substring(0, 100)
                  : `[${lastMessage.type}]`,
              createdAt: lastMessage.created_at,
              user: {
                id: lastMessage.user_id,
                name: lastMessage.user_name,
              },
            }
          : null,
        event: {
          id: membership.chat_group.event.id,
          slug: membership.chat_group.event.slug,
          title: membership.chat_group.event.title,
          coverImageUrl: membership.chat_group.event.cover_image_url,
          startTime: membership.chat_group.event.start_time,
          endTime: membership.chat_group.event.end_time,
          status: membership.chat_group.event.status,
        },
        membership: {
          role: membership.role,
          joinedAt: membership.joined_at,
        },
      }
    })

    return successResponse({
      groups: groupsWithUnread,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
    })
  } catch (error) {
    console.error("Get chat groups error:", error)
    return serverErrorResponse("Failed to get chat groups")
  }
}
