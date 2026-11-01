// Relative, not "@/lib/…": the purge (`lib/deleted-account-records.ts`) is
// reachable from server.ts, which plain tsc compiles without the alias.
import { db } from "./db"
import { logger } from "./logger"
import { deleteFile, deletePrefix, ownedObjectKey, ownedPhotoKey, sealedChatKey } from "./tigris"

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
  return new Set(rows.map((r) => chatKeyOf(r.url, userId)).filter((k): k is string => k !== null))
}

/**
 * The storage key of a chat image the person sent: a sealed copy (whose key no
 * longer names anyone, SCRUM-448), or an older object under `chat/<id>/`. The
 * rows are already the person's own, so the sealed key needs no owner in it.
 */
function chatKeyOf(url: string | null, userId: string): string | null {
  if (!url) return null
  return sealedChatKey(url) ?? ownedObjectKey(url, userId, "chat")
}

/**
 * How long past the 180-day purge a pending report can hold its image: the fifteen days IT Rules 2021 r.3(2)(a)(i) gives a
 * grievance to be resolved. Nothing else in docs/RETENTION.md or the policy allows longer, so it ends here whatever is
 * still open (SCRUM-955, owner row A-24).
 */
export const REPORT_HOLD_DAYS = 15
const REPORT_HOLD_WARN_MS = 5 * 86_400_000
const DAY_MS = 86_400_000

/** Images with a report filed before the deletion and still pending. One filed after cannot hold anything: it is gone. */
async function heldChatMedia(userId: string, deletedAt: Date) {
  const rows = await db.$queryRaw<{ url: string | null; message_id: string; message_type: string }[]>`
    SELECT m.metadata->>'mediaUrl' AS url, m.id AS message_id, 'group' AS message_type
      FROM chat_messages m
      JOIN message_reports r ON r.message_id = m.id AND r.message_type = 'group'
     WHERE m.user_id = ${userId} AND r.status = 'pending' AND r.reporter_id <> m.user_id AND r.created_at < ${deletedAt}
       AND m.metadata->>'mediaUrl' IS NOT NULL
    UNION
    SELECT p.media_url AS url, p.id AS message_id, 'private' AS message_type
      FROM private_messages p
      JOIN message_reports r ON r.message_id = p.id AND r.message_type = 'private'
     WHERE p.sender_id = ${userId} AND r.status = 'pending' AND r.reporter_id <> p.sender_id AND r.created_at < ${deletedAt}
       AND p.media_url IS NOT NULL
  `
  return rows.flatMap((r) => {
    const object_key = chatKeyOf(r.url, userId)
    return object_key ? [{ object_key, message_id: r.message_id, message_type: r.message_type }] : []
  })
}

/**
 * The purge's chat erasure: everything of the person's but the images a report still holds, each left on a pointer
 * written first, so a failure below leaves nothing unaccounted for. The record itself goes on schedule regardless.
 */
export async function erasePurgedChatMedia(record: { user_id: string; deleted_at: Date; purge_after: Date }): Promise<void> {
  const held = await heldChatMedia(record.user_id, record.deleted_at)
  if (held.length > 0) {
    await db.retained_report_media.createMany({
      data: held.map((h) => ({
        ...h,
        user_id: record.user_id,
        erase_by: new Date(record.purge_after.getTime() + REPORT_HOLD_DAYS * DAY_MS),
      })),
      skipDuplicates: true,
    })
  }
  await eraseChatMedia(record.user_id, new Set(held.map((h) => h.object_key)))
}

/** Erase each held image whose report is decided or whose cap has passed; warn about those nearing it undecided. */
export async function releaseHeldReportMedia(now: Date): Promise<void> {
  const held = await db.retained_report_media.findMany()
  for (const row of held) {
    const pending = await db.message_reports.count({
      where: { message_id: row.message_id, message_type: row.message_type, status: "pending" },
    })
    if (pending > 0 && row.erase_by > now) {
      if (row.erase_by.getTime() - now.getTime() <= REPORT_HOLD_WARN_MS) {
        logger.warn("A reported image's report must be decided before its hold ends", {
          objectKey: row.object_key,
          messageId: row.message_id,
          eraseBy: row.erase_by.toISOString(),
        })
      }
      continue
    }
    try {
      await deleteFile(row.object_key)
      await db.retained_report_media.delete({ where: { id: row.id } })
    } catch (error) {
      logger.error("Held report image NOT erased; pointer kept for the next sweep", {
        objectKey: row.object_key,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Every sealed chat copy the person's own messages point at, in rooms and DMs. */
export async function sentChatMediaKeys(userId: string): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ url: string | null }[]>`
    SELECT m.metadata->>'mediaUrl' AS url
      FROM chat_messages m
     WHERE m.user_id = ${userId} AND m.metadata->>'mediaUrl' IS NOT NULL
    UNION ALL
    SELECT p.media_url AS url
      FROM private_messages p
     WHERE p.sender_id = ${userId} AND p.media_url IS NOT NULL
  `
  return new Set(rows.map((r) => (r.url ? sealedChatKey(r.url) : null)).filter((k): k is string => k !== null))
}

/**
 * Erase a person's chat images, except `keep` (SCRUM-448).
 *
 * `chat/<id>/` holds their uploads and every copy sealed before SCRUM-448. A
 * copy sealed since carries no id, so it is found through the messages that
 * point at it: those rows outlive the account (the `User` row is anonymised,
 * never deleted). Account deletion passes the removed content to keep; the
 * purge, 180 days on, passes nothing.
 */
export async function eraseChatMedia(userId: string, keep: ReadonlySet<string>): Promise<number> {
  let gone = await deletePrefix(`chat/${userId}/`, keep)
  for (const key of await sentChatMediaKeys(userId)) {
    if (keep.has(key)) continue
    await deleteFile(key)
    gone++
  }
  return gone
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
