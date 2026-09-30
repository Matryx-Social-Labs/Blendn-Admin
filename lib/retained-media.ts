import { db } from "@/lib/db"
import { ownedObjectKey, ownedPhotoKey } from "@/lib/tigris"

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
  /*
   * Removed content, as the moderation code records it:
   *   - hidden or flagged by moderation;
   *   - deleted by someone other than the author (a host or moderator);
   *   - a flag that was not cleared (`approved` is a reviewer keeping it);
   *   - a report that was not dismissed (`reviewed` is "looked, did nothing")
   *     and was not filed by the author against themselves, which would let
   *     anyone keep their own image past their account.
   * Scoped to the person's own messages: since SCRUM-426 a message can only
   * carry its sender's upload.
   */
  const rows = await db.$queryRaw<{ url: string | null }[]>`
    SELECT m.metadata->>'mediaUrl' AS url
      FROM chat_messages m
     WHERE m.user_id = ${userId}
       AND m.metadata->>'mediaUrl' IS NOT NULL
       AND (m.moderation_status IN ('hidden', 'flagged')
            OR (m.deleted_at IS NOT NULL AND m.deleted_by IS NOT NULL AND m.deleted_by <> m.user_id)
            OR EXISTS (SELECT 1 FROM moderation_flags f WHERE f.message_id = m.id AND f.status <> 'approved')
            OR EXISTS (SELECT 1 FROM message_reports r
                        WHERE r.message_id = m.id AND r.message_type = 'group'
                          AND r.status <> 'reviewed' AND r.reporter_id <> m.user_id))
    UNION ALL
    SELECT p.media_url AS url
      FROM private_messages p
     WHERE p.sender_id = ${userId}
       AND p.media_url IS NOT NULL
       AND (p.moderation_status IN ('hidden', 'flagged')
            OR EXISTS (SELECT 1 FROM message_reports r
                        WHERE r.message_id = p.id AND r.message_type = 'private'
                          AND r.status <> 'reviewed' AND r.reporter_id <> p.sender_id))
  `
  const keys = rows
    .map((r) => (r.url ? ownedObjectKey(r.url, userId, "chat") : null))
    .filter((k): k is string => k !== null)
  return new Set(keys)
}

/**
 * A person's profile photos that moderation pulled (SCRUM-479): removed
 * content, kept 180 days after the account goes like the chat images above.
 * `moderateProfilePhoto` has already moved them to the private bucket; the
 * purge erases them with the rest of `profile/<id>/`.
 */
export async function retainedProfilePhotoKeys(userId: string): Promise<Set<string>> {
  const rows = await db.photo_checks.findMany({ where: { user_id: userId, hidden: true }, select: { url: true } })
  const keys = rows.map((r) => ownedPhotoKey(r.url, userId)).filter((k): k is string => k !== null)
  return new Set(keys)
}
