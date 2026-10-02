import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockCounterparties } from "@/lib/conversations"
import { NOT_LIVE_MESSAGE } from "@/lib/chat-window"
import { ownerDoor, ownerRoster, roomReadDenialFor, roomScope } from "@/lib/room-kind"
import { bannedRefusal } from "@/lib/moderation/actions"
import { idForViewer } from "@/lib/room-handle"
import { namesInRoom } from "@/lib/identity"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
  ErrorCode,
} from "@/lib/api-response"
import { isUuid } from "@/lib/api-input"
import { boundedInt } from "@/lib/pagination"

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

    if (!isUuid(chatGroupId)) {
      return errorResponse("Invalid chat group ID format", 400)
    }

    // Parse pagination params
    const searchParams = request.nextUrl.searchParams
    const limit = boundedInt(searchParams.get("limit"), 50, 1, 100)
    const offset = boundedInt(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER)

    // Check if chat group exists
    const chatGroup = await db.chat_groups.findUnique({
      where: { id: chatGroupId, deleted_at: null },
      select: {
        id: true,
        kind: true,
        event_id: true,
        event: { select: { status: true, deleted_at: true, kind: true } },
        ...ownerDoor(authUser.userId),
      },
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

    // The roster is part of reading the room; same rule (SCRUM-205), every kind (F8).
    const denial = roomReadDenialFor(chatGroup, membership, authUser.userId)
    if (denial === "hidden") return notFoundResponse("Chat group not found")
    if (denial === "not_member") return errorResponse("You are not a member of this chat group", 403)
    if (denial === "banned") return errorResponse(bannedRefusal(membership!), 403, ErrorCode.USER_BANNED)
    if (denial === "not_live") return errorResponse(NOT_LIVE_MESSAGE, 403, ErrorCode.NOT_LIVE)

    /*
     * A block is a safety promise, not a mute.
     *
     * The room-message work applied that to history, to the socket and to the
     * push fan-out, and stopped short of the member list — which is the one
     * screen that answers "is he in this room". Somebody who blocked their
     * harasser could still be handed a roster containing them, and could still
     * count them.
     *
     * Both directions, so it holds whichever way the block runs, and applied to
     * the count as well as the page: a filtered list under an unfiltered total
     * says "50 members" over 49 rows, which is its own quiet tell.
     */
    const hidden = await blockCounterparties(authUser.userId)
    /*
     * In a room that is not an event's, only the people its owner admits: a
     * member row is not membership there (F8). Null for an event's room.
     */
    const admitted = await ownerRoster(chatGroupId)

    const visibleMembers = {
      chat_group_id: chatGroupId,
      status: "active" as const,
      ...(hidden.length > 0 && { user_id: { notIn: hidden } }),
      // Under AND, so it never replaces the block filter's `user_id` above.
      ...(admitted && { AND: [{ user_id: { in: [...admitted] } }] }),
    }

    // Get total count
    const totalCount = await db.chat_group_members.count({
      where: visibleMembers,
    })

    // Fetch participants with user info
    const members = await db.chat_group_members.findMany({
      where: visibleMembers,
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

    const scope = roomScope(chatGroup)
    // A crew's room names its members (first names), a Blend's by tonight's
    // pseudonyms; an event's room by the pseudonym on the row (`namesInRoom`).
    const names =
      chatGroup.kind !== "event" ? await namesInRoom(chatGroup, members.map((m) => m.user.id)) : null
    return successResponse({
      participants: members.map((m) => ({
        // Yours real; everyone else's as their handle in this room (SCRUM-371).
        userId: idForViewer(authUser.userId, scope, m.user.id),
        name: names?.get(m.user.id) ?? (m.anonymous_name || "Anonymous"),
        avatar: null,
        role: m.role,
        status: m.status,
        joinedAt: m.joined_at,
      })),
      totalCount,
    })
  } catch (error) {
    logger.error("Get chat participants error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get participants")
  }
}
