import { Prisma } from "@prisma/client"

import { db } from "./db"
import { NOT_IN_THE_BELL } from "./push-notifications"

/**
 * The app icon's number, for any set of people at once.
 *
 * Unseen bell rows plus live conversations with something unread from the
 * other person (a thread, not a message; a hidden one is never counted): the
 * `badgeCount` that `GET /notifications` serves, which the phone sets while it
 * is open. A push sets it while the app is closed, so both must say the same.
 *
 * The bell's half is capped at `UNREAD_CAP` (`unreadCount` is capped there too,
 * so "999+" is all the app can say). For ONE person the count itself stops there
 * (`count` with `take`: the scan ends at the 1000th row). For several, a
 * `groupBy` cannot stop early per group, so it counts every unread row of each
 * and the cap is applied to its answer: bounded in statements, not in rows read
 * (what bounds it is that a bulk send's recipients are read through
 * `notifications (user_id, read_at)`, and that an unread backlog is rare).
 *
 * Two statements however many people are asked about: never one per user.
 */
export const UNREAD_CAP = 1000

export async function badgeCountsFor(userIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(userIds)]
  const counts = new Map<string, number>()
  if (ids.length === 0) return counts

  const unreadBell = (user_id: string | { in: string[] }) => ({ user_id, read_at: null, kind: { notIn: NOT_IN_THE_BELL as never[] } })
  const [bell, threads] = await Promise.all([
    ids.length === 1
      ? db.notifications.count({ where: unreadBell(ids[0]), take: UNREAD_CAP }).then((n) => [{ user_id: ids[0], _count: { _all: n } }])
      : db.notifications.groupBy({ by: ["user_id"], where: unreadBell({ in: ids }), _count: { _all: true } }),
    // The unread-conversation count of `GET /notifications`, for everybody in one statement. `VISIBLE_DM` written out.
    db.$queryRaw<{ user_id: string; n: number }[]>(Prisma.sql`
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
  ])

  for (const id of ids) counts.set(id, 0)
  for (const r of bell) counts.set(r.user_id, Math.min(r._count._all, UNREAD_CAP))
  for (const r of threads) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + r.n)
  return counts
}
