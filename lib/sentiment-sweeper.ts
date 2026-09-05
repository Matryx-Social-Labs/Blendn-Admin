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
  const eligible = await db.$queryRaw<{ id: string }[]>`
    SELECT m.id
      FROM chat_messages m
      JOIN chat_groups g ON g.id = m.chat_group_id
     WHERE g.status = 'active'
       AND m.type = 'text'
       AND m.deleted_at IS NULL
       AND (m.moderation_status IS NULL OR m.moderation_status <> 'hidden')
       AND m.metadata ->> 'sponsored_message_id' IS NULL
       AND NOT EXISTS (SELECT 1 FROM event_feedback f WHERE f.message_id = m.id)
     ORDER BY m.created_at ASC
     LIMIT ${MAX_MESSAGES_PER_SWEEP + 1}
  `
  const eligibleIds = eligible.map((r) => r.id)
  if (eligibleIds.length === 0) return { classified: 0, hasMore: false }

  const messages = await db.chat_messages.findMany({
    where: {
      // `status: "active"` is already the state machine for "this room is open"
      // — live event or post-event feedback window. The chat lifecycle sweeper
      // archives it afterwards, so this needs no time arithmetic of its own.
      chat_group: { status: "active" },
      type: "text",
      deleted_at: null,
      /*
       * A message that was removed should not shape the room's mood — hidden is
       * the moderation pipeline's verdict, deleted is the author's.
       *
       * Spelled as an explicit OR rather than `{ not: "hidden" }`, which is the
       * obvious way and silently wrong: `moderation_status` is nullable, SQL's
       * `<> 'hidden'` is NULL for a NULL row, and NULL is not true — so `not`
       * drops every unmoderated message. Those are set to "clean" by a
       * fire-and-forget write *after* the response, so the newest messages are
       * exactly the ones still NULL, and they are the ones a live screen is for.
       */
      OR: [{ moderation_status: null }, { moderation_status: { not: "hidden" } }],
      // `{ is: null }`, not `null` — the bare form does not filter a to-one
      // relation and quietly matches everything.
      feedback: { is: null },
      /*
       * NOT A PAID MESSAGE.
       *
       * A sponsored send is written as `type: "text"` — deliberately, because
       * `type` also carries the media kind and a sponsored send is the one
       * broadcast that may be an image, so spending it on the message kind
       * would lose that. `lib/sponsored-scheduler.ts` records the decision and
       * the marker it leaves instead: `metadata.sponsored_message_id`.
       *
       * The consequence, until now, was that an advertiser's copy was
       * classified as somebody's feeling about the event — feeding the live
       * Mood bar and appearing in the post-event digest under "what people
       * said", attributed to a pseudonym. Announcements stopped doing this when
       * they got their own `type`; ads could not follow.
       *
       * Excluded in the QUERY, never after the fetch. This selects only
       * messages with no `feedback` row, so an ad skipped in JavaScript would
       * be re-selected on every pass for ever — a batch that slowly fills with
       * work nobody can do.
       */
      id: { in: eligibleIds },
    },
    select: {
      id: true,
      content: true,
      chat_group: { select: { event_id: true } },
    },
    // Oldest first: a backlog should drain in the order it happened, so the
    // 30-minute window the live screen reads fills in chronologically.
    orderBy: { created_at: "asc" },
    take: MAX_MESSAGES_PER_SWEEP + 1,
  })

  const hasMore = messages.length > MAX_MESSAGES_PER_SWEEP
  const batch = hasMore ? messages.slice(0, MAX_MESSAGES_PER_SWEEP) : messages
  if (batch.length === 0) return { classified: 0, hasMore: false }

  const eventOf = new Map(batch.map((m) => [m.id, m.chat_group.event_id]))
  const results = await classifyMessages(batch.map((m) => ({ id: m.id, text: m.content })))

  let classified = 0
  for (const result of results) {
    const eventId = eventOf.get(result.id)
    if (!eventId) continue
    try {
      /*
       * Upsert on the unique `message_id`, which is what makes the whole thing
       * idempotent: a re-classification updates in place rather than
       * accumulating rows, so a digest cannot double-count a message.
       *
       * A human correction is never overwritten. Someone read the message and
       * disagreed with the model; running the model again must not quietly undo
       * that.
       */
      const existing = await db.event_feedback.findUnique({
        where: { message_id: result.id },
        select: { source: true },
      })
      if (existing?.source === "human") continue

      await db.event_feedback.upsert({
        where: { message_id: result.id },
        create: {
          event_id: eventId,
          message_id: result.id,
          sentiment: result.sentiment,
          category: result.category,
          confidence: result.confidence,
          source: result.source,
        },
        update: {
          sentiment: result.sentiment,
          category: result.category,
          confidence: result.confidence,
          source: result.source,
        },
      })
      classified += 1
    } catch (error) {
      // One bad row must not abandon the rest of the batch. It has no feedback
      // row, so the next pass finds it again.
      logger.error("Sentiment write failed", {
        messageId: result.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { classified, hasMore }
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
