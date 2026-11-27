import { db } from "./db"
import { openRoomHandle } from "./room-handle"
import { clipCharacters } from "./utils"

/**
 * What a report keeps of the reported words, copied when it is filed. Stored in
 * the report's `excerpt`, for staff review: no mobile response or export
 * carries it.
 */

/** A message report keeps the whole message: the longest a room takes. */
const MESSAGE_EXCERPT_MAX = 4000
/** A person report keeps their last lines where it was filed from, each bounded. */
const EVIDENCE_LINES = 20
const EVIDENCE_LINE_MAX = 500

export type EvidencePlace = { chatGroupId: string } | { eventId: string } | { conversationId: string }

/** A direct message as words: its text, and that it carried a photo. */
export function dmWords(m: { message_text: string | null; media_url: string | null }): string {
  return [m.message_text, m.media_url && "[photo]"].filter(Boolean).join(" ")
}

export const messageExcerpt = (words: string): string | null => clipCharacters(words, MESSAGE_EXCERPT_MAX) || null

/**
 * `authorId`'s last lines in a room or a conversation, oldest first, one per
 * line. Only from a place the reporter is in: a member row in the room, or one
 * of the conversation's two people. Hidden and removed lines are included: they
 * are the words a reviewer needs. Null when there are none.
 */
export async function recentLines(reporterId: string, authorId: string, place: EvidencePlace): Promise<string | null> {
  const newestFirst =
    "conversationId" in place
      ? (
          await db.private_messages.findMany({
            where: {
              sender_id: authorId,
              conversation: { id: place.conversationId, OR: [{ user1_id: reporterId }, { user2_id: reporterId }] },
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: EVIDENCE_LINES,
            select: { message_text: true, media_url: true },
          })
        ).map(dmWords)
      : (
          await db.chat_messages.findMany({
            where: {
              user_id: authorId,
              chat_group: {
                ...("eventId" in place ? { kind: "event" as const, event_id: place.eventId } : { id: place.chatGroupId }),
                members: { some: { user_id: reporterId } },
              },
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: EVIDENCE_LINES,
            select: { content: true },
          })
        ).map((m) => m.content)
  const lines = newestFirst.filter((line) => line.trim() !== "")
  if (lines.length === 0) return null
  return lines
    .map((line) => clipCharacters(line, EVIDENCE_LINE_MAX))
    .reverse()
    .join("\n")
}

/** The room or conversation a person was named from, by the handle it showed them. */
export function placeOfRef(ref: string): EvidencePlace | null {
  const opened = openRoomHandle(ref)
  if (!opened) return null
  if (typeof opened.scope === "string") return { eventId: opened.scope }
  return opened.scope.kind === "dm" ? { conversationId: opened.scope.groupId } : { chatGroupId: opened.scope.groupId }
}
