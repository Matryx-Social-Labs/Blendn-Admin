// Relative, not "@/lib/*" — reachable from server.ts, and `build:server`
// compiles with plain tsc. Enforced by __tests__/server-import-boundary.test.ts.
import { db } from "./db"
import { logger } from "./logger"
import { BATCH_SIZE, classifyMessages } from "./sentiment/classify"

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
 *   - **It retries by construction.** A message whose classification failed has
 *     no `event_feedback` row, so the next pass finds it again. No dead-letter
 *     handling, no retry counter.
 *
 * The `feedback event_feedback?` back-relation plus the unique `message_id`
 * make "not yet classified" a single indexed predicate.
 *
 * ## Cost
 *
 * `classifyMessages` runs the free lexicon tier first and only escalates what it
 * cannot settle, so the LLM sees a fraction of traffic. Work is bounded per pass
 * rather than per event, so one busy room cannot starve the others of a slot —
 * it just takes a few more passes.
 */

export const SWEEP_INTERVAL_MS = 60 * 1000

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
  const messages = await db.$queryRaw<ToClassify[]>`
    SELECT m.id, m.content, m.user_id, m.chat_group_id, g.event_id
      FROM chat_messages m
      JOIN chat_groups g ON g.id = m.chat_group_id
     WHERE g.status = 'active'
       AND g.kind = 'event'
       AND m.type = 'text'
       AND m.created_at > ${new Date(Date.now() - SCAN_WINDOW_MS)}
       AND m.deleted_at IS NULL
       AND (m.moderation_status IS NULL OR m.moderation_status <> 'hidden')
       AND m.metadata ->> 'sponsored_message_id' IS NULL
       AND NOT EXISTS (SELECT 1 FROM event_feedback f WHERE f.message_id = m.id)
     ORDER BY m.created_at ASC
     LIMIT ${MAX_MESSAGES_PER_SWEEP + 1}
  `

  const hasMore = messages.length > MAX_MESSAGES_PER_SWEEP
  const batch = hasMore ? messages.slice(0, MAX_MESSAGES_PER_SWEEP) : messages
  if (batch.length === 0) return { classified: 0, hasMore: false }

  const rowOf = new Map(batch.map((m) => [m.id, m]))
  const results = await classifyMessages(batch.map((m) => ({ id: m.id, text: m.content })))

  let written: { message_id: string }[]
  try {
    written = await writeFeedback(results.filter((r) => rowOf.has(r.id)).map((r) => ({ ...r, eventId: rowOf.get(r.id)!.event_id })))
  } catch (error) {
    // No feedback row was written, so the next pass finds the same messages again.
    logger.error("Sentiment write failed", { error: error instanceof Error ? error.message : String(error) })
    return { classified: 0, hasMore }
  }

  const resultOf = new Map(results.map((r) => [r.id, r]))
  for (const { message_id } of written) {
    /*
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
    const result = resultOf.get(message_id)
    const row = rowOf.get(message_id)
    if (result?.category !== "safety_conduct" || !row) continue
    try {
      await routeSafetyToModeration(row, result.confidence)
    } catch (error) {
      logger.error("Safety routing failed", { messageId: message_id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { classified: written.length, hasMore }
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
    INSERT INTO event_feedback (id, event_id, message_id, sentiment, category, confidence, source)
    SELECT gen_random_uuid(), v.event_id, v.message_id, v.sentiment::feedback_sentiment, v.category::issue_category, v.confidence, v.source::feedback_source
      FROM unnest(
        ${rows.map((r) => r.eventId)}::uuid[], ${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.sentiment)}::text[],
        ${rows.map((r) => r.category)}::text[], ${rows.map((r) => r.confidence)}::float8[], ${rows.map((r) => r.source)}::text[]
      ) AS v(event_id, message_id, sentiment, category, confidence, source)
      JOIN chat_messages m ON m.id = v.message_id
    ON CONFLICT (message_id) DO UPDATE
      SET sentiment = EXCLUDED.sentiment, category = EXCLUDED.category, confidence = EXCLUDED.confidence, source = EXCLUDED.source
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
}

export function stopSentimentSweeper(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
