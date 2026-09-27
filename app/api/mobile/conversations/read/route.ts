import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { VISIBLE_DM } from "@/lib/dm-moderation"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

/**
 * `POST /conversations/read` — "Mark all read" on the inbox.
 *
 * Marks exactly the set the inbox counts as unread (`GET /conversations`'s
 * `_count`): messages from the other person, in live conversations the caller
 * belongs to, that moderation has not hidden. Marking more than that set would
 * flip read receipts on messages the caller could never have seen.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "conversations-read", user.userId))
    if (limited) return limited

    const { count } = await db.private_messages.updateMany({
      where: {
        is_read: false,
        sender_id: { not: user.userId },
        ...VISIBLE_DM,
        conversation: {
          closed_at: null,
          OR: [{ user1_id: user.userId }, { user2_id: user.userId }],
        },
      },
      data: { is_read: true },
    })

    return successResponse({ marked: count })
  } catch (error) {
    logger.error("Failed to mark conversations read", { error: String(error) })
    return serverErrorResponse("Failed to mark conversations read")
  }
}
