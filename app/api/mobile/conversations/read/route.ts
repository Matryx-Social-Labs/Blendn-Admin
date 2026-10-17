import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { VISIBLE_DM } from "@/lib/dm-moderation"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { emitDelivered, emitReads, READ_RECEIPT_BATCH } from "@/lib/socket-server"

/** Ids read back per page for the emits, and the most pages: the writes themselves are unbounded predicates. */
const EMIT_PAGE = 1000
const EMIT_MAX_PAGES = 10

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

    const unread = {
      is_read: false,
      sender_id: { not: user.userId },
      ...VISIBLE_DM,
      conversation: {
        closed_at: null,
        OR: [{ user1_id: user.userId }, { user2_id: user.userId }],
      },
    }

    /*
     * What the emits name, newest first, at most READ_RECEIPT_BATCH per
     * conversation and EMIT_PAGE × EMIT_MAX_PAGES in all. A message arriving
     * between this and the writes below is marked but not named; the next
     * thread open names it.
     */
    const named = new Map<string, { read: string[]; delivered: string[] }>()
    let cursor: string | undefined
    for (let page = 0; page < EMIT_MAX_PAGES; page++) {
      const rows = await db.private_messages.findMany({
        where: unread,
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        select: { id: true, conversation_id: true, delivered_at: true },
        take: EMIT_PAGE,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      })
      for (const m of rows) {
        let entry = named.get(m.conversation_id)
        if (!entry) named.set(m.conversation_id, (entry = { read: [], delivered: [] }))
        if (entry.read.length < READ_RECEIPT_BATCH) entry.read.push(m.id)
        if (m.delivered_at === null && entry.delivered.length < READ_RECEIPT_BATCH) entry.delivered.push(m.id)
      }
      if (rows.length < EMIT_PAGE) break
      cursor = rows[rows.length - 1].id
    }

    // Delivered first, while the unread predicate still finds them: a read counts as delivered (SCRUM-408).
    await db.private_messages.updateMany({ where: { ...unread, delivered_at: null }, data: { delivered_at: new Date() } })
    const { count } = await db.private_messages.updateMany({ where: unread, data: { is_read: true } })

    for (const [conversationId, { delivered }] of named) emitDelivered(conversationId, delivered)
    emitReads(user.userId, [...named].map(([conversationId, { read }]) => [conversationId, read] as const))

    return successResponse({ marked: count })
  } catch (error) {
    logger.error("Failed to mark conversations read", { error: String(error) })
    return serverErrorResponse("Failed to mark conversations read")
  }
}
