// Relative imports throughout: this is reached from the match deck, and if it
// ever enters `server.ts`'s graph, `build:server` compiles with plain tsc and
// emits the `@/` alias verbatim into the require().
import { logger } from "./logger"

/**
 * How much attention a candidate has already had at this event.
 *
 * ## The problem this exists for
 *
 * Ranking is deterministic, so the highest-scoring person in a room is shown
 * first to **everyone**. They collect every like and everybody else gets none.
 * That is winner-take-all, and it is worse here than on a dating app because
 * the pool is one room on one night and **does not refill** — a person who is
 * ranked fourth at 9pm is ranked fourth at 11pm to the same people, and then
 * the event ends.
 *
 * The objective is not ranking accuracy, it is **pairs made**. Damping by
 * attention already received converts one popular person into several matched
 * pairs, which is the number the product is actually judged on.
 *
 * ## Why Redis, and why losing it is fine
 *
 * Impressions are written on the hottest read in the product, so Postgres would
 * be write amplification for a heuristic. Process memory is worse than either:
 * it breaks the moment there are two replicas, which is the exact mistake
 * `spam-detector.ts` made and the rate limiter was moved to Redis to fix.
 *
 * Counters are TTL'd per event-night and are **not** durable state. Losing them
 * to a restart costs one night of balancing, not data — so the in-process
 * fallback below is a real answer at one replica rather than a stub.
 */

/** Impressions expire with the night. Nothing here outlives the event. */
const TTL_MS = 12 * 60 * 60 * 1000

type RedisLike = {
  incrBy(key: string, by: number): Promise<number>
  pExpire(key: string, ms: number): Promise<unknown>
  mGet(keys: string[]): Promise<(string | null)[]>
}

/** Longest the deck waits on Redis, and how long a stall leaves it alone (as `rate-limit-store.ts`). */
const COMMAND_BOUND_MS = 500
const STALL_BACKOFF_MS = 5_000
const PING_INTERVAL_MS = 10_000

let client: (RedisLike & { isReady: boolean }) | null = null
let starting: Promise<void> | null = null
let stalledUntil = 0

/**
 * The client when it can answer now, else null, and never a wait on Redis:
 * `connect()` is started once and not awaited, because in node-redis 6 it
 * retries for ever while Redis is down (as `rate-limit-store.ts`).
 */
async function getRedis(): Promise<RedisLike | null> {
  const url = process.env.REDIS_URL
  if (!url) return null
  starting ??= startRedis(url)
  await starting
  return client?.isReady && Date.now() >= stalledUntil ? client : null
}

/**
 * Redis's answer, or a rejection after COMMAND_BOUND_MS: a stalled Redis keeps
 * `isReady` and would hold the deck (SCRUM-1378). An overrun leaves Redis alone
 * for STALL_BACKOFF_MS. See `bounded` in `rate-limit-store.ts`.
 */
async function bounded<T>(command: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const overrun = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stalledUntil = Date.now() + STALL_BACKOFF_MS
      reject(new Error(`Redis did not answer within ${COMMAND_BOUND_MS} ms`))
    }, COMMAND_BOUND_MS)
    timer.unref()
  })
  try {
    return await Promise.race([command, overrun])
  } finally {
    clearTimeout(timer)
  }
}

async function startRedis(url: string): Promise<void> {
  const unavailable = (error: unknown) =>
    logger.warn("Exposure counters falling back to memory", {
      error: error instanceof Error ? error.message : String(error),
    })
  try {
    const { createClient } = await import("redis")
    const created = createClient({ url, pingInterval: PING_INTERVAL_MS })
    // An unhandled 'error' event takes the process down, and a ranking
    // heuristic must never do that.
    created.on("error", (error: unknown) => {
      logger.warn("Exposure Redis error", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    created.connect().catch(unavailable)
    client = created as unknown as RedisLike & { isReady: boolean }
  } catch (error) {
    unavailable(error)
  }
}

/* -------------------------------------------------------------------------- */
/* In-process fallback: correct at one replica, wrong at two, and says so       */
/* -------------------------------------------------------------------------- */

const memory = new Map<string, { count: number; expiresAt: number }>()

/** Bounded, so a long-running process cannot accumulate every event ever. */
const MAX_MEMORY_KEYS = 20_000

function sweepMemory(now: number): void {
  if (memory.size < MAX_MEMORY_KEYS) return
  for (const [k, v] of memory) if (now > v.expiresAt) memory.delete(k)
  while (memory.size >= MAX_MEMORY_KEYS) {
    const oldest = memory.keys().next().value
    if (!oldest) break
    memory.delete(oldest)
  }
}

const keyFor = (eventId: string, userId: string) => `exposure:${eventId}:${userId}`

/**
 * Record that these candidates were shown to somebody.
 *
 * Never throws and never blocks the deck: an impression that goes unrecorded
 * costs a little balancing accuracy, and a deck that fails to render costs the
 * feature. Callers should not await this for correctness.
 */
export async function recordImpressions(eventId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  const now = Date.now()

  try {
    const redis = await getRedis()
    if (redis) {
      // Sent together, one round trip: commands on one connection run in order.
      await bounded(
        Promise.all(
          userIds.flatMap((id) => {
            const key = keyFor(eventId, id)
            return [redis.incrBy(key, 1), redis.pExpire(key, TTL_MS)]
          })
        )
      )
      return
    }

    sweepMemory(now)
    for (const id of userIds) {
      const key = keyFor(eventId, id)
      const existing = memory.get(key)
      if (!existing || now > existing.expiresAt) {
        memory.set(key, { count: 1, expiresAt: now + TTL_MS })
      } else {
        existing.count += 1
      }
    }
  } catch (error) {
    logger.warn("Failed to record impressions", {
      eventId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * How many times each of these has been shown at this event.
 *
 * Returns zeros rather than throwing. An exposure count that cannot be read is
 * the same as no exposure: the deck ranks exactly as it did before this
 * existed, which is a worse deck and not a broken one.
 */
export async function exposuresFor(
  eventId: string,
  userIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (userIds.length === 0) return out

  try {
    const redis = await getRedis()
    if (redis) {
      const values = await bounded(redis.mGet(userIds.map((id) => keyFor(eventId, id))))
      userIds.forEach((id, i) => out.set(id, Number(values[i] ?? 0) || 0))
      return out
    }

    const now = Date.now()
    for (const id of userIds) {
      const entry = memory.get(keyFor(eventId, id))
      out.set(id, entry && now <= entry.expiresAt ? entry.count : 0)
    }
  } catch (error) {
    logger.warn("Failed to read impressions", {
      eventId,
      error: error instanceof Error ? error.message : String(error),
    })
    for (const id of userIds) out.set(id, 0)
  }
  return out
}

/** Tests only: the in-process counters are module state. */
export function resetExposureMemory(): void {
  memory.clear()
}
