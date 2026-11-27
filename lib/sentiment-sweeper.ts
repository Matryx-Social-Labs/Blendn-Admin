// Relative, not "@/lib/*" — reachable from server.ts, and `build:server`
// compiles with plain tsc. Enforced by __tests__/server-import-boundary.test.ts.
import { Prisma } from "@prisma/client"

import { db } from "./db"
import { beat } from "./heartbeat"
import { logger } from "./logger"
import { BATCH_SIZE, classifyMessages } from "./sentiment/classify"
import { classifyWithLexicon, lexiconFallback } from "./sentiment/lexicon"

/**
 * Classify chatroom messages into `event_feedback`.
 *
 * This is the piece that was missing. The taxonomy, both classifier tiers, the
 * table with its three indexes, the live aggregation and the alert rules were
 * all built and tested — and nothing ever called `classifyMessages`, so
 * `event_feedback` was never written and both the live screen and the feedback
 * screen read a permanently empty table.
 *
 * ## Why a sweeper rather than a queue
 *
 * The obvious design is to enqueue each message id as it is sent and drain the
 * queue on a timer. A sweeper that *finds* unclassified messages is better here
 * for three reasons:
 *
 *   - **It survives a restart.** An in-process queue loses everything on deploy,
 *     and deploys happen mid-event. A sweeper picks up exactly where it left off
 *     because the work list is derived from the database, not held in memory.
 *   - **It touches nothing on the send path.** The chat POST routes already do
 *     spam, keywords, a persist and a 1 s moderation race. Adding an enqueue
 *     call to both of them is two more things to keep in sync.
 *   - **A failed write is retried by construction.** The write is one statement,
 *     so when it fails no message got a row and the next pass finds them all again.
 *     A failed *call* is too (SCRUM-1481): a line with no safety cue whose call
 *     failed gets no row, and the next pass reads it again. Only in the last
 *     `LAST_PASS_MS` of the window, on a pass the model failed, does it get the
 *     word list's guess (`source: "lexicon"`, never revisited), every such line at
 *     once, with one error that counts them. A cued line gets that guess on its
 *     first failed call, so a possible report is flagged whatever the model does.
 *     The call retries a 429, a 5xx or a timeout once (lib/sentiment/classify.ts),
 *     and each failure that stays is a Sentry issue.
 *
 * The `feedback event_feedback?` back-relation plus the unique `message_id`
 * make "not yet classified" a single indexed predicate.
 *
 * ## Cost
 *
 * `classifyMessages` runs the free lexicon tier first and only escalates what it
 * cannot settle, so the LLM sees a fraction of traffic. Work is bounded per pass,
 * and shared between rooms in turns, so one busy room cannot starve the others
 * of a slot — it just takes a few more passes itself.
 */

export const SWEEP_INTERVAL_MS = 60 * 1000
/**
 * The heartbeat's interval (lib/heartbeat.ts reports a loop after 3 of them), not the sweep's. With the model timing
 * out, one pass is up to 20 calls, 4 at a time (lib/sentiment/classify.ts), × (20 s + 2 s + 20 s) ≈ 3.5 min and still
 * finishes on the word list: 3 × 3 min clears that plus the minute between passes, so a slow OpenAI is not reported as
 * a stalled loop.
 */
const BEAT_INTERVAL_MS = 3 * 60 * 1000

/**
 * Ten batches of 20. The ceiling exists so the first pass after a quiet deploy
 * does not try to classify a whole evening at once; the backlog drains over the
 * following minutes instead.
 */
export const MAX_MESSAGES_PER_SWEEP = BATCH_SIZE * 10

export interface SentimentSweepResult {
  classified: number
  /** More messages were waiting than the cap allowed. */
  hasMore: boolean
}

export async function sweepSentiment(): Promise<SentimentSweepResult> {
  /*
   * The paid-message exclusion, in SQL, because Prisma cannot say it.
   *
   * The predicate is "the key is absent OR its value is null", and Prisma's
   * JSON filters express neither cleanly: `equals: DbNull` matches a JSON null
   * and not an absent key, which is the common case here since most messages
   * carry no metadata at all. `->>` returns NULL for both, which is exactly the
   * question — verified against Postgres rather than assumed.
   *
   * Bounded by the same limit as the fetch below, so this cannot become an
   * unbounded id list on a busy night.
   */
  // Every open event room, a venue day's included: an escalation here is how an
  // unclaimed venue's room, with no host watching, reaches the platform's queue.
  // Event rooms only: what is classified is how people feel about an event
  // (`event_feedback.event_id`), and a crew's or a Blend's chat has no event to
  // feel about. Left in, its messages would be selected on every pass for ever.
  /*
   * Everything the pass needs, in the one statement that finds the work: the
   * text, the author, the room and its event. This was ids here and a second
   * `findMany` (with a nested read of the room) to fetch what the ids already
   * sat beside.
   *
   * Only messages younger than `SCAN_WINDOW_MS`. Without it the anti-join
   * walked every text message of every open room, from the oldest, each pass
   * (300k messages: 196 ms and 900k buffers to find three). A message still
   * unclassified after hours is not worth a place in the queue; a room stays
   * open to end + 24 h, but its mood is a live figure.
   */
  /*
   * A fair share per room (G7). Each open event room offers its waiting
   * messages (a pass's worth at most, through its own
   * (chat_group_id, created_at) index), and the pass takes them in turns:
   * every room's first, then every room's second, and so on. Oldest-first
   * across rooms let one concert room's backlog take every slot, so every
   * other room's mood was a pass late for as long as the backlog lasted. A
   * room alone still gets the whole pass. Which messages are classified, and
   * how, is unchanged; only the order the pass reaches them in.
   */
  /*
   * SCRUM-1481: a room's lines in the last `LAST_PASS_MS` of the window first, then its newest. Oldest first, a
   * backlog the model could not read during an outage filled every pass, and a fresh line, a new safety report
   * included, was never selected until the outage ended. Newest first alone, the oldest lines left the window unread
   * and uncounted.
   *
   * ponytail: a middle line can wait. During an outage a pass runs every SWEEP_INTERVAL_MS plus the pass (a round of
   * calls, under 45 s), and a fresh line is read only while it is among its room's newest MAX_MESSAGES_PER_SWEEP (200)
   * less the room's band. A room writing more than that between two passes can leave a line, a cued one included,
   * unread until it reaches the band, where it is read first, or flagged from its cue if the model is still down; or
   * until the model answers again, when a backlog drains at 1 s re-passes. A per-room fresh quota is the upgrade.
   */
  const now = Date.now()
  const windowStart = new Date(now - SCAN_WINDOW_MS)
  const lastPassBefore = new Date(now - SCAN_WINDOW_MS + LAST_PASS_MS)
  const messages = await db.$queryRaw<ToClassify[]>`
    SELECT id, content, user_id, chat_group_id, event_id
      FROM (
        SELECT m.id, m.content, m.user_id, m.chat_group_id, g.event_id, m.created_at, m.last_pass,
               row_number() OVER (PARTITION BY m.chat_group_id ORDER BY m.last_pass DESC, m.created_at DESC) AS turn
          FROM chat_groups g
          CROSS JOIN LATERAL (
            SELECT m.id, m.content, m.user_id, m.chat_group_id, m.created_at, m.created_at <= ${lastPassBefore} AS last_pass
              FROM chat_messages m
             WHERE m.chat_group_id = g.id
               AND m.created_at > ${windowStart}
               AND ${UNCLASSIFIED}
             ORDER BY last_pass DESC, m.created_at DESC
             LIMIT ${MAX_MESSAGES_PER_SWEEP + 1}
          ) m
         WHERE g.status = 'active'
           AND g.kind = 'event'
      ) q
     ORDER BY turn, last_pass DESC, created_at DESC
     LIMIT ${MAX_MESSAGES_PER_SWEEP + 1}
  `

  const hasMore = messages.length > MAX_MESSAGES_PER_SWEEP
  const batch = hasMore ? messages.slice(0, MAX_MESSAGES_PER_SWEEP) : messages
  if (batch.length === 0) return { classified: 0, hasMore: false }

  const rowOf = new Map(batch.map((m) => [m.id, m]))
  const results = await classifyMessages(batch.map((m) => ({ id: m.id, text: m.content, room: m.chat_group_id })))

  let written: { message_id: string }[]
  try {
    written = await writeFeedback(results.filter((r) => rowOf.has(r.id)).map((r) => ({ ...r, eventId: rowOf.get(r.id)!.event_id })))
  } catch (error) {
    // No feedback row was written, so the next pass finds the same messages again.
    logger.error("Sentiment write failed", { error: error instanceof Error ? error.message : String(error) })
    return { classified: 0, hasMore }
  }
  await routeSafety(written, results, rowOf)

  // A message the classifier did not reach this pass (its call cap) has no row yet: the next pass comes at once.
  if (results.deferred === 0) return { classified: written.length, hasMore: hasMore || results.length < batch.length }

  // The model failed this pass. The next pass waits the interval (coming straight back would only fail again), and the
  // lines about to leave the window are settled now, whether this pass read them or not.
  const settled = await settleLastPass(windowStart, lastPassBefore)
  return { classified: written.length + settled, hasMore: false }
}

/**
 * Every unclassified line of an open event room: text, not deleted or hidden, not an advertiser's copy (the
 * paid-message exclusion above), and with no feedback row.
 */
const UNCLASSIFIED = Prisma.sql`m.type = 'text'
               AND m.deleted_at IS NULL
               AND (m.moderation_status IS NULL OR m.moderation_status <> 'hidden')
               AND m.metadata ->> 'sponsored_message_id' IS NULL
               AND NOT EXISTS (SELECT 1 FROM event_feedback f WHERE f.message_id = m.id)`

/** The last minutes of the scan window: a line still unread there is read first, and settled on a failed pass. */
export const LAST_PASS_MS = 10 * 60_000
/**
 * The lines a failed pass settles on the word list: no model call, so not the call batch's 200, but one statement's
 * worth. Past it a line leaves the window unrowed, and the pass's error counts it.
 */
export const MAX_SETTLED_PER_PASS = 5_000

/**
 * On a pass the model failed, every line in the last `LAST_PASS_MS` of the window still with no row gets the word
 * list's guess: the model will not be asked again before the line leaves the window. One error a pass with the
 * counts, never a text or an id: an outage that outlives the window must be seen, and the per-call errors stop at the
 * window. Returns the rows written.
 */
async function settleLastPass(windowStart: Date, lastPassBefore: Date): Promise<number> {
  const band = await db.$queryRaw<Array<ToClassify & { waiting: bigint }>>`
    SELECT m.id, m.content, m.user_id, m.chat_group_id, g.event_id, count(*) OVER () AS waiting
      FROM chat_groups g
      JOIN chat_messages m ON m.chat_group_id = g.id
     WHERE g.status = 'active'
       AND g.kind = 'event'
       AND m.created_at > ${windowStart}
       AND m.created_at <= ${lastPassBefore}
       AND ${UNCLASSIFIED}
     ORDER BY m.created_at
     LIMIT ${MAX_SETTLED_PER_PASS}
  `
  if (band.length === 0) return 0
  const rowOf = new Map(band.map((m) => [m.id, m]))
  const results = band.map((m) => ({ id: m.id, ...(classifyWithLexicon(m.content) ?? lexiconFallback(m.content)) }))
  const written = await writeFeedback(results.map((r) => ({ ...r, eventId: rowOf.get(r.id)!.event_id })))
  await routeSafety(written, results, rowOf)
  logger.error("Sentiment lines left the window unread by the model", {
    settled: written.length,
    unsettled: Number(band[0].waiting) - band.length,
  })
  return written.length
}

/**
 * "Routed to moderation regardless of sentiment" -- the live tab's Safety
 * alert has said this since it was written, and nothing did it. Driven
 * 2026-09-13: "some guy keeps following me around the bar and grabbed
 * my arm" was classified safety_conduct, opened a critical issue, and
 * never reached the moderation queue -- no flag row, no "flags waiting",
 * no human unless somebody happened to open the live tab.
 *
 * A flag, never a hide: this is a person asking for help, and hiding it
 * is the one action that makes things worse. `flagged` on the message
 * only when nothing stronger is already there.
 */
async function routeSafety(
  written: ReadonlyArray<{ message_id: string }>,
  results: ReadonlyArray<{ id: string; category: string; confidence: number }>,
  rowOf: ReadonlyMap<string, ToClassify>
): Promise<void> {
  const resultOf = new Map(results.map((r) => [r.id, r]))
  for (const { message_id } of written) {
    const result = resultOf.get(message_id)
    const row = rowOf.get(message_id)
    if (result?.category !== "safety_conduct" || !row) continue
    try {
      await routeSafetyToModeration(row, result.confidence)
    } catch (error) {
      logger.error("Safety routing failed", { messageId: message_id, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** How far back the pass looks for messages to classify. */
export const SCAN_WINDOW_MS = 6 * 60 * 60_000

interface ToClassify {
  id: string
  content: string
  user_id: string
  chat_group_id: string
  event_id: string
}

/**
 * One statement for the pass, on the unique `message_id`, which is what makes
 * the whole thing idempotent: a re-classification updates in place rather than
 * accumulating rows, so a digest cannot double-count a message.
 *
 * A human correction is never overwritten. Someone read the message and
 * disagreed with the model; running the model again must not quietly undo
 * that -- the `WHERE` skips it, and it is not returned. A message deleted while
 * the model was reading it is simply not joined, where a row per message made
 * that one failed write among the rest.
 */
async function writeFeedback(
  results: ReadonlyArray<Awaited<ReturnType<typeof classifyMessages>>[number] & { eventId: string }>
): Promise<{ message_id: string }[]> {
  if (results.length === 0) return []
  const last = new Map(results.map((r) => [r.id, r]))
  const rows = [...last.values()]
  return db.$queryRaw<{ message_id: string }[]>`
    INSERT INTO event_feedback (id, event_id, message_id, sentiment, category, topic, confidence, source)
    SELECT gen_random_uuid(), v.event_id, v.message_id, v.sentiment::feedback_sentiment, v.category::issue_category, v.topic::feedback_topic, v.confidence, v.source::feedback_source
      FROM unnest(
        ${rows.map((r) => r.eventId)}::uuid[], ${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.sentiment)}::text[],
        ${rows.map((r) => r.category)}::text[], ${rows.map((r) => r.topic)}::text[], ${rows.map((r) => r.confidence)}::float8[], ${rows.map((r) => r.source)}::text[]
      ) AS v(event_id, message_id, sentiment, category, topic, confidence, source)
      JOIN chat_messages m ON m.id = v.message_id
    ON CONFLICT (message_id) DO UPDATE
      SET sentiment = EXCLUDED.sentiment, category = EXCLUDED.category, topic = EXCLUDED.topic, confidence = EXCLUDED.confidence, source = EXCLUDED.source
      WHERE event_feedback.source <> 'human'
    RETURNING message_id`
}

/** One flag per message: the sweeper re-runs, the queue must not fill with copies. */
async function routeSafetyToModeration(
  row: { id: string; chat_group_id: string; user_id: string },
  confidence: number
): Promise<void> {
  const existing = await db.moderation_flags.findFirst({
    where: { message_id: row.id },
    select: { id: true },
  })
  if (existing) return
  await db.$transaction([
    db.moderation_flags.create({
      data: {
        message_id: row.id,
        chat_group_id: row.chat_group_id,
        user_id: row.user_id,
        source: "auto_text",
        categories: ["safety_conduct"],
        confidence,
        auto_action: "none",
      },
    }),
    db.chat_messages.updateMany({
      where: { id: row.id, OR: [{ moderation_status: null }, { moderation_status: "clean" }] },
      data: { moderation_status: "flagged" },
    }),
  ])
}

let timer: NodeJS.Timeout | null = null

/**
 * Started from `lib/socket-server.ts` alongside the other two sweepers rather
 * than from `server.ts` — a second scheduler would be a second thing to
 * remember to start.
 *
 * Self-scheduling rather than `setInterval`: a pass that takes longer than the
 * interval must not overlap itself, because two passes classifying the same
 * message means two LLM calls for one row.
 */
export function startSentimentSweeper(): void {
  if (timer) return

  const run = async () => {
    try {
      const result = await sweepSentiment()
      beat("sentiment", BEAT_INTERVAL_MS)
      if (result.classified > 0) {
        logger.info("Sentiment sweep", { ...result })
      }
      // A backlog drains at full speed rather than one cap per minute.
      timer = setTimeout(() => void run(), result.hasMore ? 1_000 : SWEEP_INTERVAL_MS)
    } catch (error) {
      logger.error("Sentiment sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      timer = setTimeout(() => void run(), SWEEP_INTERVAL_MS)
    }
  }

  timer = setTimeout(() => void run(), SWEEP_INTERVAL_MS)
  beat("sentiment", BEAT_INTERVAL_MS)
}

export function stopSentimentSweeper(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
