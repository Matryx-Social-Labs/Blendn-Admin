import { NextRequest } from "next/server"

import {
  errorResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { bellRowFor, declaredChannelSet, NOT_IN_THE_BELL } from "@/lib/push-notifications"
import { VISIBLE_DM } from "@/lib/dm-moderation"
import { decorateNotifications, type RowDecoration } from "@/lib/notification-display"
import { cursorPaginationMeta, parseCursorPagination } from "@/lib/pagination"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { isUuid } from "@/lib/api-input"

/**
 * `GET /notifications` — the bell's feed, newest first.
 *
 * ## Cursor, not page
 *
 * This is an append-heavy list: rows arrive while somebody is reading it, and
 * offset pagination on a list that grows at the head silently repeats items —
 * page 2 shifts by however many landed since page 1. The same reason chat
 * messages use a cursor. `@@index([user_id, created_at])` serves the order.
 *
 * ## It returns only your own
 *
 * `user_id` comes from the token, never from a query parameter. There is no
 * "whose notifications" question to get wrong, which is the shape every
 * identity leak in this repo has had: `interestedPreview` returned other
 * people's faces to any authenticated caller, and the dashboard chat route
 * returned other people's messages. A notification carries a title and a body
 * that may name a person, so this endpoint is exactly as sensitive.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    /*
     * No rate limit on the read, matching every other mobile GET in this repo
     * (`conversations`, `events`, `categories` all limit only their writes).
     * Both queries here are index-served — `@@index([user_id, created_at])` for
     * the feed and `@@index([user_id, read_at])` for the count.
     */
    const { searchParams } = new URL(request.url)
    const { cursor, limit } = parseCursorPagination(
      searchParams.get("cursor") ?? undefined,
      searchParams.get("limit") ?? undefined
    )
    if (cursor && !isUuid(cursor)) return errorResponse("Invalid cursor", 400)
    const unreadOnly = searchParams.get("unread") === "true"

    const rows = await db.notifications.findMany({
      where: {
        user_id: user.userId,
        // Messages live in their inbox; see `NOT_IN_THE_BELL`. Rows written
        // before that rule stay until retention takes them, unseen.
        kind: { notIn: NOT_IN_THE_BELL },
        ...(unreadOnly ? { read_at: null } : {}),
      },
      orderBy: { created_at: "desc" },
      // One extra, so `cursorPaginationMeta` can tell whether there is another
      // page without a second count query.
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        data: true,
        read_at: true,
        created_at: true,
      },
    })

    const { items, meta } = cursorPaginationMeta(rows, limit)

    /*
     * The unread count ships with the feed.
     *
     * The bell needs it on every screen, and returning it here saves the app a
     * second request on the one call it already makes when the sheet opens.
     * `@@index([user_id, read_at])` exists for this count.
     */
    const [unreadCount, unreadConversations, decorations] = await Promise.all([
      db.notifications.count({
        where: { user_id: user.userId, read_at: null, kind: { notIn: NOT_IN_THE_BELL } },
      }),
      /*
       * The app-icon badge's other half: live conversations with something
       * unread from the other person. A thread, not a message — the same unit
       * the Banter list marks — and a hidden message is never delivered, so it
       * is never counted (`VISIBLE_DM`).
       */
      db.private_conversations.count({
        where: {
          closed_at: null,
          OR: [{ user1_id: user.userId }, { user2_id: user.userId }],
          messages: { some: { is_read: false, sender_id: { not: user.userId }, ...VISIBLE_DM } },
        },
      }),
      /*
       * Decoration is a bonus on a row, never a reason for the bell to fail: it
       * reads six other tables, and a failure in any of them (or in a row's odd
       * payload) must leave the feed as it was before it existed, with the old
       * fields and no `display`. Logged, so it is not silent.
       */
      decorateNotifications(
        user.userId,
        items.map((n) => ({ id: n.id, kind: n.kind, payload: n.data }))
      ).catch((error: unknown) => {
        logger.error("Failed to decorate notifications", { error: error instanceof Error ? error.message : String(error) })
        return new Map<string, RowDecoration>()
      }),
    ])

    const channelSet = declaredChannelSet(request.headers)
    return successResponse({
      notifications: items.map((row) => bellRowFor(row, channelSet)).map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        // The same payload the push carried, so the app has one deep-link
        // switch rather than two that can disagree.
        data: n.data,
        readAt: n.read_at,
        createdAt: n.created_at,
        // What the row can say for the reader beyond the push's nameless words (lib/notification-display.ts).
        ...decorations.get(n.id),
      })),
      unreadCount,
      // The app icon's number: unseen bell rows plus conversations with something unread.
      badgeCount: unreadCount + unreadConversations,
      pagination: meta,
    })
  } catch (error) {
    logger.error("Failed to list notifications", { error: String(error) })
    return serverErrorResponse("Failed to load notifications")
  }
}

/**
 * `DELETE /notifications` — clear the feed.
 *
 * Deletes rather than marks read: "clear all" that leaves every row in place
 * is a lie the next retention query trips over. Scoped to the caller by the
 * same rule as `GET`.
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "notifications", user.userId))
    if (limited) return limited

    const { count } = await db.notifications.deleteMany({ where: { user_id: user.userId } })
    return successResponse({ deleted: count })
  } catch (error) {
    logger.error("Failed to clear notifications", { error: String(error) })
    return errorResponse("Failed to clear notifications", 500)
  }
}
