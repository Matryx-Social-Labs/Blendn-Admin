import { db } from "@/lib/db"
import { ownedObjectKey } from "@/lib/tigris"

/**
 * A person's chat images that must outlive their account (SCRUM-428).
 *
 * Account deletion erases `chat/<id>/`. The exceptions are images in messages
 * that are removed content: hidden or flagged by moderation, carrying a
 * moderation flag, or reported. Those are kept 180 days after the author
 * leaves (docs/RETENTION.md, IT Rules 2021 r.3(1)(g)), in rooms and in DMs.
 *
 * Returned as storage keys. A URL that is not the person's own `chat/` object
 * yields nothing: there is nothing of theirs to keep, or to delete.
 */
export async function retainedChatMediaKeys(userId: string): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ url: string }[]>`
    SELECT m.metadata->>'mediaUrl' AS url
      FROM chat_messages m
     WHERE m.user_id = ${userId}
       AND m.metadata ? 'mediaUrl'
       AND (m.moderation_status IN ('hidden', 'flagged')
            OR EXISTS (SELECT 1 FROM moderation_flags f WHERE f.message_id = m.id)
            OR EXISTS (SELECT 1 FROM message_reports r WHERE r.message_id = m.id AND r.message_type = 'group'))
    UNION
    SELECT p.media_url AS url
      FROM private_messages p
     WHERE p.sender_id = ${userId}
       AND p.media_url IS NOT NULL
       AND (p.moderation_status IN ('hidden', 'flagged')
            OR EXISTS (SELECT 1 FROM message_reports r WHERE r.message_id = p.id AND r.message_type = 'private'))
  `
  const keys = rows.map((r) => ownedObjectKey(r.url, userId, "chat")).filter((k): k is string => k !== null)
  return new Set(keys)
}
