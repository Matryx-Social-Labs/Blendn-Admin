// Relative imports: run by the chat-lifecycle sweeper, which server.ts reaches.
import { Prisma } from "@prisma/client"

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
 * (until it is decided), or upheld within the 180 days; and the whole
 * conversation while one of its two people has such a report on the other (a
 * person report, which "unmatch and report" files when no message is named).
 * A sender's report of their own message holds nothing. A dismissed report's
 * excerpt goes 180 days after the dismissal (`purgeClosedLobbies`). A DM is
 * removed by moderation only at send (`screenDirectMessage` stores it hidden),
 * before its conversation closed, so its 180 days from removal are always over
 * here and no moderation hold applies.
 *
 * The words of the request that opened the conversation go with it
 * (`message_requests.message`); a conversation opened at an event waits for
 * that event's insight counts to be frozen.
 *
 * **Kept:** the conversation row and the request row. A closed pair stays
 * apart on every surface (`pairIsClosed`, `closedPairKeys`, the friends and
 * room rules read it), and neither says anything of what was written.
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
  /** Requests whose opening words went with their conversation. */
  openers: number
  hasMore: boolean
}

/** A report on message `m` that holds it (not its sender's own). */
const messageHeld = (since: Date) => Prisma.sql`
  EXISTS (SELECT 1 FROM message_reports r
           WHERE r.message_id = m.id AND r.message_type = 'private' AND r.reporter_id <> m.sender_id
             AND ${holdingReport(since)})`

/**
 * A conversation `c` past its time: closed more than 180 days ago, no person
 * report between its two people still holding it, and, when it was opened at
 * an event (in its room or from a Lobby ask, both set `origin_event_id`) that
 * still exists, that event's insight counts frozen first
 * (`event_insight_tallies`), as the Lobby purge waits: its "kept talking"
 * reads these messages. An event that is gone has no counts to wait for.
 */
const conversationPastItsTime = (since: Date) => Prisma.sql`
       c.closed_at < ${since}
   AND NOT EXISTS (SELECT 1 FROM user_reports r
                    WHERE ((r.reporter_id = c.user1_id AND r.reported_id = c.user2_id)
                        OR (r.reporter_id = c.user2_id AND r.reported_id = c.user1_id))
                      AND ${holdingReport(since)})
   -- any-kind: a venue day's counts are frozen like any event's, so a conversation opened there waits for them too.
   AND NOT EXISTS (SELECT 1 FROM events e
                    WHERE e.id = c.origin_event_id
                      AND NOT EXISTS (SELECT 1 FROM event_insight_tallies t WHERE t.event_id = e.id))`

/*
 * A lookup per closed conversation, not a join: the planner reads the inner
 * LIMIT as a per-conversation index probe on `(conversation_id)`, so a pass
 * with nothing due never scans `private_messages`, whatever its statistics say.
 * ponytail: every conversation closed past the window is probed each pass,
 * emptied ones too (about 140 ms warm, 730 ms cold at 20,000 closed with
 * 100,000 person reports, locally; the pool's statement timeout is 8 s). Mark
 * emptied conversations (`messages_purged_at` and a partial index) before
 * that count nears 100,000.
 */
async function messagesPastTheirTime(since: Date) {
  return db.$queryRaw<PastTheirTime[]>`
    SELECT p.id, p.media_url AS url, p.sender_id AS author_id
      FROM private_conversations c
     CROSS JOIN LATERAL (
       SELECT m.id, m.media_url, m.sender_id
         FROM private_messages m
        WHERE m.conversation_id = c.id
          AND NOT ${messageHeld(since)}
        LIMIT ${DM_BATCH}
     ) p
     WHERE ${conversationPastItsTime(since)}
     LIMIT ${DM_BATCH}
  `
}

/**
 * The words of the request that opened such a conversation (`message_requests.message`,
 * returned by `GET /message-requests` for as long as the row stands): the conversation's
 * first words, so they go with it. The request row stays (who asked whom, and when).
 */
async function blankOpeners(since: Date): Promise<number> {
  return db.$executeRaw`
    UPDATE message_requests SET message = NULL, updated_at = now()
     WHERE id IN (
       SELECT q.id
         FROM private_conversations c
        CROSS JOIN LATERAL (
          SELECT q.id FROM message_requests q
           WHERE q.message IS NOT NULL
             AND ((q.sender_id = c.user1_id AND q.recipient_id = c.user2_id)
               OR (q.sender_id = c.user2_id AND q.recipient_id = c.user1_id))
        ) q
        WHERE ${conversationPastItsTime(since)}
        LIMIT ${DM_BATCH})`
}

/** One bounded pass. Idempotent: every delete is of rows the select just found past their time. */
export async function purgeClosedConversations(now: Date = new Date()): Promise<DmPurgePass> {
  const since = new Date(now.getTime() - RETENTION_DAYS * DAY_MS)
  const due = await messagesPastTheirTime(since)
  const gone = await deleteObjects(due, "DM purge")
  // The hold asked again: a report filed while storage was being deleted keeps its message (its photo is gone, its words stay).
  const messages = gone.ids.length
    ? await db.$executeRaw`DELETE FROM private_messages m WHERE m.id = ANY(${gone.ids}::uuid[]) AND NOT ${messageHeld(since)}`
    : 0
  warnRefused("DM purge", gone.refused)
  const openers = await blankOpeners(since)
  return { messages, photos: gone.photos, kept: gone.kept, openers, hasMore: due.length === DM_BATCH || openers === DM_BATCH }
}
