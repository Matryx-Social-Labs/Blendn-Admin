import { NextRequest } from "next/server"
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

    // Get unread counts for each group
    const groupsWithUnread = await Promise.all(
      memberships.map(async (membership) => {
        let unreadCount = 0

        if (membership.last_read_message_id) {
          // Get the timestamp of the last read message
          const lastReadMessage = await db.chat_messages.findUnique({
            where: { id: membership.last_read_message_id },
            select: { created_at: true },
          })

          if (lastReadMessage) {
            unreadCount = await db.chat_messages.count({
              where: {
                chat_group_id: membership.chat_group_id,
                created_at: { gt: lastReadMessage.created_at },
                deleted_at: null,
              },
            })
          }
        } else {
          // User hasn't read any messages, count all
          unreadCount = membership.chat_group._count.messages
        }

        // Get last message
        const lastMessage = await db.chat_messages.findFirst({
          where: {
            chat_group_id: membership.chat_group_id,
            deleted_at: null,
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { created_at: "desc" },
        })

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
                user: lastMessage.user,
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
    )

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
