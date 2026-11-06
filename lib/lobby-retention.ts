// Relative imports: run by the chat-lifecycle sweeper, which server.ts reaches.
import { Prisma } from "@prisma/client"

import { CHAT_WINDOW_HOURS } from "./chat-window"
import { db } from "./db"
import { tallyFeedback } from "./feedback-digest"
import { logger } from "./logger"
import { deleteFile, isConfigured, sealedChatKey } from "./tigris"

/**
 * What the Lobby, the room and the posts' rooms held, 180 days after they
 * closed (SCRUM-1026, owner decision 6, 2026-11-05).
 *
 * They close for users at the same moment, a day after the event ends, and
 * from then on nothing in the app reads them (`roomReadDenial`, `lobbyState`).
 * They are kept server-side for 180 days for safety, reports and legal
 * requests, and then this hard-deletes them: room messages (an event's and a
 * post's), Lobby posts with their asks (`board_requests` cascades) and their
 * photos in storage, the posts' rooms, the host's pinned posts. Alert switches
 * go at the close itself: they have nothing to keep.
 *
 * **What the room felt stays** (owner, 2026-11-06). An event's `event_feedback`
 * rows are kept, detached from their message and from whoever corrected them,
 * and before the event's first message goes its per-category contributor
 * counts and its room's size are frozen (`event_feedback_tallies`), so the
 * Feedback tab reads the same after the purge as before it, with no id, no
 * words and no pseudonym left. A dismissed report's `excerpt` goes 180 days
 * after the dismissal.
 *
 * **Removed content is held 180 days from its removal**, whatever the close
 * says (IT Rules 2021, r.3(1)(g)):
 *
 *   - a message removed by anyone but its author (a host, a moderator, the
 *     pipeline), or carrying a moderation flag nobody cleared;
 *   - a post moderation took down (`removed`, `hidden`), or whose photo it
 *     rejected;
 *   - anything with a report still pending (held until it is decided), or
 *     upheld (`resolved`) within the 180 days.
 *
 * A post is purged only once its room holds no message, so a held message
 * keeps its post and its room. Account deletion keeps its own path
 * (`DELETE /api/mobile/account`); this only ever takes what is past its time.
 *
 * Dry run unless `LOBBY_PURGE=delete`: a pass then logs what it would delete.
 * `off` does nothing. The privacy policy names these windows once the owner
 * and the lawyer have signed the wording (`.context/plans/privacy-retention-draft.md`).
 */
export const RETENTION_DAYS = 180

const DAY_MS = 24 * 60 * 60 * 1000
const MESSAGE_BATCH = 5_000
const POST_BATCH = 500

export type PurgeMode = "off" | "log" | "delete"

/** `LOBBY_PURGE`: unset is a dry run that logs; `delete` deletes; `off` does nothing. */
export function purgeModeFromEnv(raw: string | undefined = process.env.LOBBY_PURGE): PurgeMode {
  const v = raw?.trim().toLowerCase()
  return v === "delete" ? "delete" : v === "off" ? "off" : "log"
}

export interface PurgePass {
  mode: PurgeMode
  messages: number
  posts: number
  photos: number
  hostPosts: number
  alertPreferences: number
  /** Feedback rows detached from a purged message (kept, anonymous). */
  feedback: number
  /** Dismissed reports whose excerpt went. */
  excerpts: number
  /** Objects whose delete failed: their rows are kept for the next pass. */
  kept: number
  hasMore: boolean
}

/** When a room closes, in SQL: a venue day's at its reset, any other a day after it ends (`chatClosesAt`). */
const closesAt = Prisma.sql`(CASE WHEN e.kind = 'venue_day' THEN e.end_time ELSE e.end_time + make_interval(hours => ${CHAT_WINDOW_HOURS}) END)`

/** A report that holds what it names: still pending, or upheld within the window. */
const holdingReport = (since: Date) => Prisma.sql`(r.status = 'pending' OR (r.status = 'resolved' AND r.reviewed_at > ${since}))`

async function messagesPastTheirTime(since: Date) {
  return db.$queryRaw<{ id: string; media_url: string | null }[]>`
    SELECT m.id, m.metadata->>'mediaUrl' AS media_url
      FROM chat_messages m
      JOIN chat_groups g ON g.id = m.chat_group_id
      LEFT JOIN board_posts bp ON bp.id = g.board_post_id
      JOIN events e ON e.id = COALESCE(g.event_id, bp.event_id)
     WHERE g.kind IN ('event', 'board_post')
       AND ${closesAt} < ${since}
       AND NOT COALESCE(m.deleted_at IS NOT NULL AND m.deleted_by IS DISTINCT FROM m.user_id AND m.deleted_at > ${since}, false)
       AND NOT EXISTS (SELECT 1 FROM moderation_flags f
                        WHERE f.message_id = m.id AND f.status <> 'approved'
                          AND (f.status = 'pending' OR COALESCE(f.reviewed_at, f.created_at) > ${since}))
       AND NOT EXISTS (SELECT 1 FROM message_reports r
                        WHERE r.message_id = m.id AND r.message_type = 'group' AND ${holdingReport(since)})
     LIMIT ${MESSAGE_BATCH}
  `
}

async function postsPastTheirTime(since: Date) {
  return db.$queryRaw<{ id: string; photo_url: string | null }[]>`
    SELECT p.id, p.photo_url
      FROM board_posts p
      JOIN events e ON e.id = p.event_id
     WHERE ${closesAt} < ${since}
       -- COALESCE: on a post with no moderation status or no photo these are NULL, and NOT NULL would drop the row.
       AND NOT COALESCE(p.moderation_status IN ('removed', 'hidden') AND p.deleted_at > ${since}, false)
       AND NOT COALESCE(p.photo_status = 'rejected' AND p.photo_checked_at > ${since}, false)
       AND NOT EXISTS (SELECT 1 FROM message_reports r
                        WHERE r.message_type = 'board_post' AND r.message_id = p.id AND ${holdingReport(since)})
       AND NOT EXISTS (SELECT 1 FROM board_requests q
                         JOIN message_reports r ON r.message_type = 'board_request' AND r.message_id = q.id
                        WHERE q.post_id = p.id AND ${holdingReport(since)})
       AND NOT EXISTS (SELECT 1 FROM chat_groups g JOIN chat_messages m ON m.chat_group_id = g.id WHERE g.board_post_id = p.id)
     LIMIT ${POST_BATCH}
  `
}

/** Storage first, then the row: an object whose delete failed keeps its row, so the next pass finds it again. */
async function deleteObjects<T extends { id: string }>(rows: T[], urlOf: (row: T) => string | null): Promise<{ ids: string[]; photos: number; kept: number }> {
  const ids: string[] = []
  let photos = 0
  let kept = 0
  for (const row of rows) {
    const url = urlOf(row)
    const key = url ? sealedChatKey(url) : null
    if (!key) {
      ids.push(row.id)
      continue
    }
    try {
      if (!isConfigured()) throw new Error("storage not configured")
      await deleteFile(key)
      photos++
      ids.push(row.id)
    } catch (error) {
      kept++
      logger.error("Lobby purge: object NOT deleted; its row is kept for the next pass", {
        rowId: row.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { ids, photos, kept }
}

/** One bounded pass. Idempotent: every delete is of rows the selects just found past their time. */
export async function purgeClosedLobbies(now: Date = new Date(), mode: PurgeMode = purgeModeFromEnv()): Promise<PurgePass> {
  const pass: PurgePass = { mode, messages: 0, posts: 0, photos: 0, hostPosts: 0, alertPreferences: 0, feedback: 0, excerpts: 0, kept: 0, hasMore: false }
  if (mode === "off") return pass
  const since = new Date(now.getTime() - RETENTION_DAYS * DAY_MS)

  const messages = await messagesPastTheirTime(since)
  const posts = await postsPastTheirTime(since)
  pass.hasMore = messages.length === MESSAGE_BATCH || posts.length === POST_BATCH

  if (mode === "log") {
    const [hostPosts, prefs, feedback, excerpts] = await Promise.all([
      db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM board_host_posts h JOIN events e ON e.id = h.event_id WHERE ${closesAt} < ${since}`,
      db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM board_alert_preferences a JOIN events e ON e.id = a.event_id WHERE ${closesAt} < ${now}`,
      db.event_feedback.count({ where: { message_id: { in: messages.map((m) => m.id) } } }),
      db.message_reports.count({ where: dismissedPastTheirTime(since) }),
    ])
    return {
      ...pass,
      messages: messages.length,
      posts: posts.length,
      photos: [...messages.map((m) => m.media_url), ...posts.map((p) => p.photo_url)].filter((u) => u && sealedChatKey(u)).length,
      hostPosts: Number(hostPosts[0]?.n ?? 0),
      alertPreferences: Number(prefs[0]?.n ?? 0),
      feedback,
      excerpts,
    }
  }

  const gone = await deleteObjects(messages, (m) => m.media_url)
  if (gone.ids.length) {
    await freezeFeedbackTallies(gone.ids)
    const [detached, deleted] = await db.$transaction([
      // Kept, and nobody's: the message link (ON DELETE CASCADE would take the row) and the staff id that corrected it.
      db.event_feedback.updateMany({ where: { message_id: { in: gone.ids } }, data: { message_id: null, corrected_by: null } }),
      db.chat_messages.deleteMany({ where: { id: { in: gone.ids } } }),
    ])
    pass.feedback = detached.count
    pass.messages = deleted.count
  }

  const postsGone = await deleteObjects(posts, (p) => p.photo_url)
  if (postsGone.ids.length) {
    const [, deleted] = await db.$transaction([
      // The post's room first: `board_post_id` is ON DELETE RESTRICT. Its messages are gone (the select required it); members cascade.
      db.chat_groups.deleteMany({ where: { board_post_id: { in: postsGone.ids } } }),
      db.board_posts.deleteMany({ where: { id: { in: postsGone.ids } } }),
    ])
    pass.posts = deleted.count
  }
  pass.photos = gone.photos + postsGone.photos
  pass.kept = gone.kept + postsGone.kept

  pass.hostPosts = await db.$executeRaw`DELETE FROM board_host_posts h USING events e WHERE e.id = h.event_id AND ${closesAt} < ${since}`
  pass.alertPreferences = await db.$executeRaw`DELETE FROM board_alert_preferences a USING events e WHERE e.id = a.event_id AND ${closesAt} < ${now}`
  pass.excerpts = (await db.message_reports.updateMany({ where: dismissedPastTheirTime(since), data: { excerpt: null } })).count
  return pass
}

/** A dismissed report (`reviewed`) 180 days after its dismissal, still holding the words it quoted. */
const dismissedPastTheirTime = (since: Date) => ({ status: "reviewed" as const, reviewed_at: { lt: since }, excerpt: { not: null } })

/**
 * Before an event's first message goes: what its feedback adds up to, counted
 * as the digest counts it, while every author is still known. Once per event
 * (the first pass that reaches it); a later pass finds the tally and skips it.
 */
async function freezeFeedbackTallies(messageIds: string[]): Promise<void> {
  const reached = await db.event_feedback.findMany({
    // any-kind: a venue day's room is classified and purged like any event's, so its feedback is frozen too.
    where: { message_id: { in: messageIds }, event: { feedback_tally: null } },
    distinct: ["event_id"],
    select: { event_id: true },
  })
  for (const { event_id } of reached) {
    const [rows, population] = await Promise.all([
      db.event_feedback.findMany({ where: { event_id }, select: { sentiment: true, category: true, message: { select: { user_id: true } } } }),
      db.chat_group_members.count({ where: { chat_group: { event_id } } }),
    ])
    const { contributors } = tallyFeedback(rows.map((r) => ({ sentiment: r.sentiment, category: r.category, userId: r.message?.user_id ?? null })))
    await db.event_feedback_tallies.createMany({
      data: [{ event_id, population, contributors: Object.fromEntries(contributors) }],
      skipDuplicates: true,
    })
  }
}
