// Relative imports: see lib/conversations.ts. Enforced by __tests__/server-import-boundary.test.ts.
import { db } from "./db"
import { VISIBLE_DM_SQL } from "./dm-moderation"

export interface InboxPreview {
  id: string
  message_text: string | null
  sender_id: string
  created_at: Date
  is_read: boolean
}

/**
 * The newest visible message of each of these conversations, in ONE query.
 *
 * Replaces a nested `messages: { take: 1 }` on the conversation list, which the
 * client turned into a per-conversation read. Visible is `VISIBLE_DM`'s rule
 * (`VISIBLE_DM_SQL`), so a hidden or moderated message never gives the row words
 * the thread refuses to show.
 *
 * A lateral lookup per listed conversation rather than `DISTINCT ON`: that reads
 * every message of every listed conversation to keep one, which for a long
 * thread is the whole thread. This takes one row per conversation off the
 * `(conversation_id, created_at)` index. The ids are bound as an array, never
 * interpolated.
 */
export async function latestVisibleMessages(conversationIds: readonly string[]): Promise<Map<string, InboxPreview>> {
  if (conversationIds.length === 0) return new Map()
  const rows = await db.$queryRaw<(InboxPreview & { conversation_id: string })[]>`
    SELECT m."conversation_id", m."id", m."message_text", m."sender_id", m."created_at", m."is_read"
      FROM unnest(${conversationIds as string[]}::uuid[]) AS c(id)
     CROSS JOIN LATERAL (
       SELECT "private_messages"."conversation_id", "private_messages"."id", "private_messages"."message_text",
              "private_messages"."sender_id", "private_messages"."created_at", "private_messages"."is_read"
         FROM "private_messages"
        WHERE "private_messages"."conversation_id" = c.id AND ${VISIBLE_DM_SQL}
        ORDER BY "private_messages"."created_at" DESC, "private_messages"."id" DESC
        LIMIT 1
     ) m`
  return new Map(rows.map(({ conversation_id, ...preview }) => [conversation_id, preview]))
}
