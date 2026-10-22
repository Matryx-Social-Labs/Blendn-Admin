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
 * so "999+" is all the app can say), which also bounds the count's cost.
 *
 * Two statements however many people are asked about: never one per user.
 */
export const UNREAD_CAP = 1000

export async function badgeCountsFor(userIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(userIds)]
  const counts = new Map<string, number>()
  if (ids.length === 0) return counts

  const [bell, threads] = await Promise.all([
    db.notifications.groupBy({
      by: ["user_id"],
      where: { user_id: { in: ids }, read_at: null, kind: { notIn: NOT_IN_THE_BELL as never[] } },
      _count: { _all: true },
    }),
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
