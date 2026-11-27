// Relative imports: run by the chat-lifecycle sweeper, which server.ts reaches.
import { db } from "./db"
import { deleteObjects, holdingReport, RETENTION_DAYS, warnRefused, type PastTheirTime } from "./lobby-retention"

/**
 * Direct messages, 180 days after their conversation closed (SCRUM-1237,
 * register D-029: "180 days after the conversation closes or the account is
 * deleted, with holds for open reports").
 *
 * A conversation closes on an unmatch, a block, or either person's account
 * deletion (`eraseAccount` closes every open one of theirs), and nothing
 * reopens it (`closeConversation`). From then on no app read returns it: the
 * inbox, the thread, the unread counts and the badge all read `closed_at IS
 * NULL`. 180 days on, this hard-deletes its messages, both sides', and the
 * photo each carries (`deleteObjects`: the sender's own object only, as the
 * Lobby purge does). An open conversation is never touched, however old.
 *
 * **Held**, as the Lobby purge holds: a message under a report still pending
 * (until it is decided), or upheld within the 180 days. A dismissed report's
 * excerpt goes 180 days after the dismissal (`purgeClosedLobbies`). A DM is
 * removed by moderation only at send (`screenDirectMessage` stores it hidden),
 * before its conversation closed, so its 180 days from removal are always over
 * here and no moderation hold applies.
 *
 * **Kept:** the conversation row. A closed pair stays apart on every surface
 * (`pairIsClosed`, `closedPairKeys`, the friends and room rules read it), and
 * its counters say nothing of what was written.
 *
 * Every pass deletes; there is no dry run (SCRUM-1227).
 */
export const DM_BATCH = 5_000
const DAY_MS = 24 * 60 * 60 * 1000

export interface DmPurgePass {
  messages: number
  photos: number
  /** Objects whose delete failed: their rows are kept for the next pass. */
  kept: number
  hasMore: boolean
}

/*
 * A lookup per closed conversation, not a join: the planner reads the inner
 * LIMIT as a per-conversation index probe on `(conversation_id)`, so a pass
 * with nothing due never scans `private_messages`, whatever its statistics say.
 * ponytail: every conversation closed past the window is probed each pass
 * (one empty index probe each); mark emptied conversations if that count ever
 * reaches the hundreds of thousands.
 */
async function messagesPastTheirTime(since: Date) {
  return db.$queryRaw<PastTheirTime[]>`
    SELECT p.id, p.media_url AS url, p.sender_id AS author_id
      FROM private_conversations c
     CROSS JOIN LATERAL (
       SELECT m.id, m.media_url, m.sender_id
         FROM private_messages m
        WHERE m.conversation_id = c.id
          AND NOT EXISTS (SELECT 1 FROM message_reports r
                           WHERE r.message_id = m.id AND r.message_type = 'private' AND ${holdingReport(since)})
        LIMIT ${DM_BATCH}
     ) p
     WHERE c.closed_at < ${since}
     LIMIT ${DM_BATCH}
  `
}

/** One bounded pass. Idempotent: every delete is of rows the select just found past their time. */
export async function purgeClosedConversations(now: Date = new Date()): Promise<DmPurgePass> {
  const since = new Date(now.getTime() - RETENTION_DAYS * DAY_MS)
  const due = await messagesPastTheirTime(since)
  const gone = await deleteObjects(due, "DM purge")
  warnRefused("DM purge", gone.refused)
  const messages = gone.ids.length ? (await db.private_messages.deleteMany({ where: { id: { in: gone.ids } } })).count : 0
  return { messages, photos: gone.photos, kept: gone.kept, hasMore: due.length === DM_BATCH }
}
