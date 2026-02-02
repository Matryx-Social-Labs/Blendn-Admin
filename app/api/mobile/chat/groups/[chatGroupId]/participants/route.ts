import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ chatGroupId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const { chatGroupId } = await params

    // Validate chatGroupId is a valid UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(chatGroupId)) {
      return errorResponse("Invalid chat group ID format", 400)
    }

    // Parse pagination params
    const searchParams = request.nextUrl.searchParams
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100)
    const offset = parseInt(searchParams.get("offset") || "0")

    // Check if chat group exists
    const chatGroup = await db.chat_groups.findUnique({
      where: { id: chatGroupId, deleted_at: null },
      select: { id: true },
    })

    if (!chatGroup) {
      return notFoundResponse("Chat group not found")
    }

    // Verify user is a member of the chat group
    const membership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroupId,
          user_id: authUser.userId,
        },
      },
    })

    if (!membership) {
      return errorResponse("You are not a member of this chat group", 403)
    }

    // Get total count
    const totalCount = await db.chat_group_members.count({
      where: {
        chat_group_id: chatGroupId,
        status: "active",
      },
    })

    // Fetch participants with user info
    const members = await db.chat_group_members.findMany({
      where: {
        chat_group_id: chatGroupId,
        status: "active",
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
      orderBy: [{ role: "asc" }, { joined_at: "asc" }],
      skip: offset,
      take: limit,
    })

    return successResponse({
      participants: members.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        avatar: m.user.image,
        role: m.role,
        status: m.status,
        joinedAt: m.joined_at,
      })),
      totalCount,
    })
  } catch (error) {
    console.error("Get chat participants error:", error)
    return serverErrorResponse("Failed to get participants")
  }
}
