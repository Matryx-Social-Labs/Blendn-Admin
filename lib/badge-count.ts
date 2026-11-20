import { Prisma } from "@prisma/client"

import { db } from "./db"
import { NOT_IN_THE_BELL } from "./push-notifications"

/**
 * What the app icon, the bell and the Banter dot count, for any set of people at once (requests placement A).
 *
 * - `bell`: unseen bell rows the bell answers. Talk-asks (`TALK_ASK_KINDS`: a message request, a Lobby ask, a reveal
 *   ask) lead to a chat, so they are history lines there and never light it. This is `unreadCount`.
 * - `threads`: live conversations with something unread from the other person (a thread, not a message; a hidden
 *   message is never counted, `VISIBLE_DM` written out).
 * - `messageRequests`: pending message requests to the person, as `GET /message-requests` counts them.
 * - `lobbyAsks`: Lobby asks waiting on the person, as `GET /board/requests` lists its live incoming ones: pending, not
 *   silenced, the post standing, the night not over, nobody blocked either way.
 *
 * The icon (`badgeCount`, `iconBadge`) is all four: the bell plus the Banter dot. `GET /notifications` serves it and a
 * push sets it while the app is closed, so both read it here.
 *
 * The bell's half is capped at `UNREAD_CAP` ("999+" is all the app can say). For ONE person the count itself stops
 * there (`count` with `take`: the scan ends at the 1000th row). For several, a `groupBy` cannot stop early per group, so
 * it counts every unread row of each and the cap is applied to its answer: bounded in statements, not in rows read.
 *
 * Four statements however many people are asked about: never one per user.
 */
export const UNREAD_CAP = 1000

/** The kinds that open a chat: in the feed as plain lines, never in the bell's count (requests placement A). */
export const TALK_ASK_KINDS = ["message_request", "board_request", "reveal_request"] as const

/** Unseen rows the bell counts, for one person or several. */
export const unreadBellWhere = (user_id: string | { in: string[] }) => ({
  user_id,
  read_at: null,
  kind: { notIn: [...NOT_IN_THE_BELL, ...TALK_ASK_KINDS] as never[] },
})

export interface InboxCounts {
  bell: number
  threads: number
  messageRequests: number
  lobbyAsks: number
}

export const iconBadge = (c: InboxCounts): number => c.bell + c.threads + c.messageRequests + c.lobbyAsks

export async function inboxCountsFor(userIds: readonly string[], now: Date = new Date()): Promise<Map<string, InboxCounts>> {
  const ids = [...new Set(userIds)]
  const counts = new Map<string, InboxCounts>()
  if (ids.length === 0) return counts

  type Row = { user_id: string; n: number }
  const [bell, threads, messageRequests, lobbyAsks] = await Promise.all([
    ids.length === 1
      ? db.notifications.count({ where: unreadBellWhere(ids[0]), take: UNREAD_CAP }).then((n) => [{ user_id: ids[0], _count: { _all: n } }])
      : db.notifications.groupBy({ by: ["user_id"], where: unreadBellWhere({ in: ids }), _count: { _all: true } }),
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT c.uid AS user_id, COUNT(*)::int AS n
      FROM (
        SELECT id, user1_id AS uid FROM private_conversations WHERE closed_at IS NULL AND user1_id = ANY(${ids}::text[])
        UNION ALL
        SELECT id, user2_id AS uid FROM private_conversations WHERE closed_at IS NULL AND user2_id = ANY(${ids}::text[])
      ) c
      WHERE EXISTS (
        SELECT 1 FROM private_messages m
        WHERE m.conversation_id = c.id AND m.is_read = false AND m.sender_id <> c.uid
          AND (m.moderation_status IS NULL OR m.moderation_status <> 'hidden')
      )
      GROUP BY c.uid
    `),
    // `@@index([recipient_id, status])`.
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT recipient_id AS user_id, COUNT(*)::int AS n
      FROM message_requests
      WHERE recipient_id = ANY(${ids}::text[]) AND status = 'pending'
      GROUP BY recipient_id
    `),
    // `liveRequest` + `VISIBLE_TO_AUTHOR` + the block either way, written out; `@@index([to_user_id, status, created_at])`.
    // any-kind: an ask waits on you in any Lobby, a venue day's included, as `GET /board/requests` lists it.
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT r.to_user_id AS user_id, COUNT(*)::int AS n
      FROM board_requests r
      JOIN events e ON e.id = r.event_id
      JOIN board_posts p ON p.id = r.post_id
      WHERE r.to_user_id = ANY(${ids}::text[]) AND r.status = 'pending' AND r.silenced_at IS NULL
        AND e.end_time > ${now} AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM blocked_users b
          WHERE (b.blocker_id = r.to_user_id AND b.blocked_id = r.from_user_id)
             OR (b.blocker_id = r.from_user_id AND b.blocked_id = r.to_user_id)
        )
      GROUP BY r.to_user_id
    `),
  ])

  for (const id of ids) counts.set(id, { bell: 0, threads: 0, messageRequests: 0, lobbyAsks: 0 })
  const add = (rows: readonly Row[], key: keyof InboxCounts) => {
    for (const r of rows) counts.set(r.user_id, { ...counts.get(r.user_id)!, [key]: r.n })
  }
  add(bell.map((r) => ({ user_id: r.user_id, n: Math.min(r._count._all, UNREAD_CAP) })), "bell")
  add(threads, "threads")
  add(messageRequests, "messageRequests")
  add(lobbyAsks, "lobbyAsks")
  return counts
}

/** The app icon's number for each person: what a push carries. */
export async function badgeCountsFor(userIds: readonly string[]): Promise<Map<string, number>> {
  const counts = await inboxCountsFor(userIds)
  return new Map([...counts].map(([id, c]) => [id, iconBadge(c)]))
}
