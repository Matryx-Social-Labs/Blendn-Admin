import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { VISIBLE_DM } from "@/lib/dm-moderation"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { emitDelivered, emitRead } from "@/lib/socket-server"

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

    const unread = await db.private_messages.findMany({
      where: {
        is_read: false,
        sender_id: { not: user.userId },
        ...VISIBLE_DM,
        conversation: {
          closed_at: null,
          OR: [{ user1_id: user.userId }, { user2_id: user.userId }],
        },
      },
      select: { id: true, conversation_id: true, delivered_at: true },
    })
    const ids = unread.map((m) => m.id)
    if (ids.length > 0) {
      await db.private_messages.updateMany({ where: { id: { in: ids } }, data: { is_read: true } })
      // Read counts as delivered (SCRUM-408).
      await db.private_messages.updateMany({ where: { id: { in: ids }, delivered_at: null }, data: { delivered_at: new Date() } })
    }

    // Each conversation hears its own: the read, and the delivery it had not had.
    const byConversation = new Map<string, typeof unread>()
    for (const m of unread) byConversation.set(m.conversation_id, [...(byConversation.get(m.conversation_id) ?? []), m])
    for (const [conversationId, messages] of byConversation) {
      emitDelivered(conversationId, messages.filter((m) => m.delivered_at === null).map((m) => m.id))
      emitRead(conversationId, messages.map((m) => m.id), user.userId)
    }
    const count = ids.length

    return successResponse({ marked: count })
  } catch (error) {
    logger.error("Failed to mark conversations read", { error: String(error) })
    return serverErrorResponse("Failed to mark conversations read")
  }
}
