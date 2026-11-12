import type { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { MESSAGE_REQUEST } from "@/lib/constants"
import { logCapHit, rateLimit, rateLimitedResponse, userLimit } from "@/lib/rate-limit"
import { hit, peek } from "@/lib/rate-limit-store"

/*
 * The sender's caps on message requests (SCRUM-1050), beside the door's 30 a
 * minute and 20 a day. Both read only the sender, and the route calls them
 * before it looks at the recipient, so a refusal says nothing about who the
 * request was to: not a block, not whether they were ever in a room with you.
 */

/** The silent 201s (`countSilentRequest`), so the unanswered cap counts them like real requests. */
const silentKey = (userId: string) => `mr:silent:${userId}`

/**
 * The 429 for a sender over a cap, or null.
 *
 * - An account under a day old sends 3 a day (`newAccountRequestDay`), counted
 *   at the door like the 20, so every attempt counts the same.
 * - At most `MAX_UNANSWERED` out at once: requests from the last week that were
 *   not accepted (a decline and a block are never told, so they still look
 *   unanswered to the sender), plus the silent 201s of the same week.
 */
export async function requestSenderRefusal(request: NextRequest, userId: string): Promise<NextResponse | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { createdAt: true } })
  if (user && Date.now() - user.createdAt.getTime() < MESSAGE_REQUEST.NEW_ACCOUNT_MS) {
    const limited = await rateLimit(request, userLimit("newAccountRequestDay", "message-request-day-new", userId))
    if (limited) return limited
  }

  const since = new Date(Date.now() - MESSAGE_REQUEST.UNANSWERED_WINDOW_MS)
  const where = { sender_id: userId, status: { not: "accepted" as const }, created_at: { gte: since } }
  const [unanswered, silent] = await Promise.all([db.message_requests.count({ where }), peek(silentKey(userId))])
  if (unanswered + silent < MESSAGE_REQUEST.MAX_UNANSWERED) return null

  logCapHit(userId, "message-request-unanswered", MESSAGE_REQUEST.MAX_UNANSWERED)
  // When the oldest one ages out and frees a slot.
  const oldest = await db.message_requests.findFirst({ where, orderBy: { created_at: "asc" }, select: { created_at: true } })
  const freesAt = (oldest?.created_at.getTime() ?? Date.now()) + MESSAGE_REQUEST.UNANSWERED_WINDOW_MS
  return rateLimitedResponse(MESSAGE_REQUEST.MAX_UNANSWERED, freesAt)
}

/**
 * A silent 201 holds a slot as a real request does. Without it, somebody with 9
 * out could tell which roster card is a friend: the one after which a 10th
 * still goes through.
 */
// ponytail: one fixed week from the first silent 201, not per request; a per-request age-out would need a stored row.
export async function countSilentRequest(userId: string): Promise<void> {
  await hit(silentKey(userId), MESSAGE_REQUEST.UNANSWERED_WINDOW_MS)
}
