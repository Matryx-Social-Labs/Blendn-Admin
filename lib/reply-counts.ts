import { db } from "@/lib/db"

/**
 * How many replies each of these messages has, for a page of history: every
 * child row counts, a deleted one included, as the `_count.replies` it replaces
 * did. Scoped to the page's ids, so it reads the `parent_id` index for those
 * messages and not every message on the platform.
 */
export async function replyCounts(messageIds: string[]): Promise<Map<string, number>> {
  if (messageIds.length === 0) return new Map()
  const rows = await db.chat_messages.groupBy({
    by: ["parent_id"],
    where: { parent_id: { in: messageIds } },
    _count: { _all: true },
  })
  return new Map(rows.flatMap((r) => (r.parent_id ? [[r.parent_id, r._count._all] as const] : [])))
}
