// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { db } from "./db"
import { logger } from "./logger"

/**
 * The event registry, and the only way to write one.
 *
 * ## Why a registry and not a string
 *
 * A free-text event name is how an analytics schema becomes unqueryable within
 * a quarter: `app_open`, `app_opened`, `appOpen` and `open_app` all arrive, a
 * rollup reads one of them, and the number is quietly a quarter of the truth.
 * The union below is the schema, `tsc` enforces it at every call site, and a
 * name nobody reads fails the registry test rather than reading zero forever.
 *
 * ## What is deliberately NOT here
 *
 * Every stage of the loop-closure funnel — signed up, onboarded, RSVP'd,
 * checked in, matched, conversed, came back — is a row in a table and is
 * counted from it. Emitting them here too would give one question two answers,
 * which is the defect this whole audit is about. This table carries only the
 * signals with nothing behind them.
 */
export const PRODUCT_EVENTS = {
  /**
   * An authenticated request arrived, so the app was open.
   *
   * This is the one that matters. `activeThisWeek` is distinct refresh-token
   * holders in seven days — documented in-repo as a proxy — and D1/D7/D30 built
   * on that would be wrong in a way a diligent investor finds. Recorded once
   * per person per day.
   */
  app_opened: "app_opened",
  /** The discovery feed was read. The funnel's missing `browsed` stage. */
  feed_browsed: "feed_browsed",
  /** One event's detail was opened. */
  event_viewed: "event_viewed",
  /** Somebody searched. Never what for — see `props` on the model. */
  searched: "searched",
} as const

export type ProductEventName = (typeof PRODUCT_EVENTS)[keyof typeof PRODUCT_EVENTS]

/**
 * A day key in UTC.
 *
 * UTC rather than the viewer's timezone, deliberately: DAU has to be one number
 * over one calendar, and a per-user local day makes "how many people opened the
 * app on the 3rd" unanswerable because different people's 3rds overlap.
 */
export const dayKey = (at: Date): string => at.toISOString().slice(0, 10)

/*
 * Buffered, and flushed in one statement — not written per request.
 *
 * ## Why the obvious version was wrong
 *
 * `record` is called from `getAuthenticatedUser`, so it sits on the path of
 * every authenticated request. A first draft wrote immediately and relied on a
 * per-process cache to make the steady state one write per person per day. A
 * cold cache has no steady state: on the first request after a deploy, every
 * request from every user fires a write at once, and they all queue for the
 * same connection pool the requests themselves need.
 *
 * That is not a theory. The integration suite went from green to
 * `sorry, too many clients already`, with real routes returning **500** because
 * analytics had taken the connections. The same herd arrives on every deploy
 * and again at midnight UTC when the day key rolls over.
 *
 * An in-flight cap was the second attempt and was the wrong shape: it still put
 * a query on the request path, and it only reduced how many. Buffering removes
 * the query from that path entirely — the cost of counting somebody is now a
 * `Set` insert, and the database sees at most one statement per flush window no
 * matter how much traffic there is.
 *
 * ## What a crash costs
 *
 * Up to one flush window of first-opens, and nothing else — because the write
 * is idempotent, the next request that person makes today records them. That is
 * the same trade `record` already makes by never throwing, and it is why this
 * needs no outbox: the requirement was exactly-once *counting*, and a unique
 * index plus a retry-by-accident gives that.
 */
const FLUSH_MS = 10_000
/** Ceiling on the buffer, so a flush failure cannot grow it without bound. */
const MAX_BUFFERED = 5_000
/**
 * Ceiling on the seen-set. `event_viewed` is keyed per entity, so it grows with
 * users x events-viewed-per-day — fine at a hundred people and a leak at a
 * hundred thousand. On overflow it is dropped whole and a few redundant no-op
 * inserts are paid; the database is what guarantees correctness.
 */
const MAX_CACHED_KEYS = 50_000

interface Pending {
  name: string
  user_id: string
  entity_kind: string | null
  entity_id: string | null
  dedupe_key: string
  occurred_at: Date
}

let seenDay = ""
let seen = new Set<string>()
let buffer: Pending[] = []
let lastFlush = 0
/**
 * The flush currently running, if any.
 *
 * Held as a promise rather than a boolean so a second caller **awaits** the
 * one in progress instead of being told "nothing to do". A boolean made
 * `flushProductEvents` return 0 while a flush it had itself triggered was still
 * writing — which is a shutdown drain that does not drain, and a test that
 * asserts on rows a moment before they exist.
 */
let flushing: Promise<number> | null = null

/** Test seam for the module-level buffer and cache. Production never wants it. */
export function resetProductEventCache(): void {
  seenDay = ""
  seen = new Set<string>()
  buffer = []
  lastFlush = 0
  flushing = null
}

/**
 * Write whatever is buffered, in one statement.
 *
 * Exported so a test can force it and so shutdown can drain — an unflushed
 * buffer at SIGTERM is one window of signals lost for no reason.
 */
export async function flushProductEvents(): Promise<number> {
  if (flushing) return flushing
  if (buffer.length === 0) return 0

  const batch = buffer
  buffer = []
  lastFlush = Date.now()

  flushing = (async () => {
    try {
      const { count } = await db.product_events.createMany({
        data: batch,
        skipDuplicates: true,
      })
      return count
    } catch (error) {
      /*
       * Dropped, not requeued. Requeueing a failing batch is how a buffer
       * becomes unbounded, and every row in it is recoverable by the next
       * request that person makes today.
       */
      logger.debug("product events not flushed", {
        dropped: batch.length,
        error: String(error),
      })
      return 0
    } finally {
      flushing = null
    }
  })()

  return flushing
}

/**
 * Record a signal. Safe to call on every request, and safe to call twice.
 *
 * Synchronous in effect: it appends to a buffer and returns. Nothing here can
 * fail a request, delay one, or take a connection from one.
 */
export function record(input: {
  name: ProductEventName
  userId?: string | null
  entityKind?: string
  entityId?: string
  at?: Date
}): void {
  try {
    /*
     * An anonymous signal cannot be deduped by person, so it would collapse
     * every signed-out browser into one row per day and call it one person. A
     * count wrong by an unknowable factor is worse than one that admits it
     * covers only signed-in people.
     */
    if (!input.userId) return

    const at = input.at ?? new Date()
    const day = dayKey(at)
    const key = [input.userId, day, input.name, input.entityId ?? ""].join(":")

    if (day !== seenDay) {
      seenDay = day
      seen = new Set()
    }
    if (seen.has(key)) return
    if (seen.size >= MAX_CACHED_KEYS) seen = new Set()
    seen.add(key)

    if (buffer.length < MAX_BUFFERED) {
      buffer.push({
        name: input.name,
        user_id: input.userId,
        entity_kind: input.entityKind ?? null,
        entity_id: input.entityId ?? null,
        dedupe_key: key,
        occurred_at: at,
      })
    }

    if (Date.now() - lastFlush >= FLUSH_MS) {
      // Fire and forget: the caller is serving a request and must not wait.
      void flushProductEvents()
    }
  } catch (error) {
    logger.debug("product event not recorded", { error: String(error) })
  }
}

/**
 * How many distinct people opened the app since `since`.
 *
 * ## Why this returns its own source
 *
 * `activeThisWeek` has been distinct refresh-token holders in seven days — a
 * figure whose own tile calls it a "session proxy", and which really answers
 * *whose token happened to be issued this week*. It is the reason R36 sequences
 * retention **after** this table exists: D1/D7/D30 built on it would be wrong
 * in a way a diligent investor finds.
 *
 * The honest replacement has a transition problem. This table starts empty, so
 * for the first week the true answer and "we are not collecting yet" are the
 * same number, and a tile reading zero over a live product is worse than a
 * proxy that at least moves.
 *
 * So the caller is told which source it got and labels the number accordingly.
 * One question, one source at a time, and the screen always says which — the
 * same rule the degraded-occupancy work applied to a soft number.
 */
export async function activeSince(
  since: Date
): Promise<{ count: number; source: "app_opens" | "none" }> {
  const count = await db.product_events.count({
    where: { name: PRODUCT_EVENTS.app_opened, occurred_at: { gte: since } },
  })
  /*
   * A count of rows IS a count of people here, because `dedupe_key` is
   * `user:day:name` — one row per person per day. Over a seven-day window a
   * person can contribute up to seven, so this is person-days rather than
   * people, and the distinct count is the honest one.
   */
  if (count === 0) return { count: 0, source: "none" }

  const rows = await db.product_events.findMany({
    where: { name: PRODUCT_EVENTS.app_opened, occurred_at: { gte: since } },
    select: { user_id: true },
    distinct: ["user_id"],
  })
  return { count: rows.length, source: "app_opens" }
}
