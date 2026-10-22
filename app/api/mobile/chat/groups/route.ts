import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockCounterparties } from "@/lib/conversations"
import { PAGINATION } from "@/lib/constants"
import {
  buildChatRows,
  eventMemberArgs,
  eventRowsWithEvent,
  EVENT_ROOM_WHERE,
  LISTED_MEMBER_STATUSES,
  liveRoomsOnly,
  openRooms,
  otherMemberArgs,
  OTHER_ROOM_WHERE,
} from "@/lib/chat-group-rows"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { boundedInt, paginationMeta } from "@/lib/pagination"

export async function GET(request: NextRequest) {
  try {
    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Archiving moved to app/api/cron/archive-chats. Doing it here meant it
    // only ran when somebody happened to open their chat list, so a room
    // nobody looked at stayed active indefinitely.

    // Parse pagination params
    const searchParams = request.nextUrl.searchParams
    const page = boundedInt(searchParams.get("page"), 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = boundedInt(searchParams.get("limit"), PAGINATION.DEFAULT_LIMIT, 1, PAGINATION.MAX_LIMIT)

    // Which venue rooms are live, and what a mute does not remove: `lib/chat-group-rows.ts`.
    const now = new Date()
    const live = liveRoomsOnly(now)

    /*
     * A row says only what the room's history would show this viewer: no
     * preview, sender or unread count from somebody in a block with them,
     * either way — the history route's own filter (`blockCounterparties`).
     * Counted, or previewed, a blocked person's message told the blocker they
     * were still talking (step 9 review of the chat list).
     */
    const blockedIds = await blockCounterparties(authUser.userId)
    // What can be unread: never a blocked person's line, nor your own.
    const notUnread = [...blockedIds, authUser.userId]
    const unreadMessages = { deleted_at: null, user_id: { notIn: notUnread } }
    const listed = { user_id: authUser.userId, status: { in: [...LISTED_MEMBER_STATUSES] } }

    // Get total count of user's chat groups
    const totalCount = await db.chat_group_members.count({
      where: { ...listed, chat_group: EVENT_ROOM_WHERE, ...live },
    })

    // Fetch user's chat group memberships with chat group and event details
    const rows = await db.chat_group_members.findMany({
      where: { ...listed, chat_group: EVENT_ROOM_WHERE, ...live },
      ...eventMemberArgs(unreadMessages),
      orderBy: {
        chat_group: {
          last_message_at: "desc",
        },
      },
      skip: (page - 1) * limit,
      take: limit,
    })

    const memberships = eventRowsWithEvent(rows)

    /*
     * Crew and Blend rooms (step 9): the viewer's crews' chats, and their
     * Blends while open — each as its door admits them now (a member of the
     * crew; on a side of the Blend, in no block across it). A list of their
     * own, `rooms`, not rows of `groups`: an installed app reads `event` off
     * every `groups` row, and these rooms have none. Not paged — a person is in
     * at most `CREW.MAX_JOINED` crews and a night's few Blends — so sent with
     * the first page only.
     */
    const otherRows = page > 1 ? [] : await db.chat_group_members.findMany({
      where: { ...listed, chat_group: OTHER_ROOM_WHERE },
      ...otherMemberArgs(authUser.userId, unreadMessages),
    })
    const others = openRooms(otherRows, authUser.userId)

    const built = await buildChatRows({ userId: authUser.userId, memberships, others, notUnread, blockedIds, now })
    // Newest visible message first, then rooms with none yet.
    const rooms = [...built.rooms].sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))

    return successResponse({
      /** Event and venue-day rooms, paged. Each says `kind: "event"`. */
      groups: built.groups,
      /** Crew and Blend rooms, newest message first, not paged (see above). */
      rooms,
      pagination: paginationMeta(page, limit, totalCount),
    })
  } catch (error) {
    logger.error("Get chat groups error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get chat groups")
  }
}
