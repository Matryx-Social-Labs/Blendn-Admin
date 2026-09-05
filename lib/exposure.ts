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

let clientPromise: Promise<RedisLike | null> | null = null

async function getRedis(): Promise<RedisLike | null> {
  const url = process.env.REDIS_URL
  if (!url) return null

  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const { createClient } = await import("redis")
        const client = createClient({ url })
        // An unhandled 'error' event takes the process down, and a ranking
        // heuristic must never do that.
        client.on("error", (error: unknown) => {
          logger.warn("Exposure Redis error", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
        await client.connect()
        return client as unknown as RedisLike
      } catch (error) {
        logger.warn("Exposure counters falling back to memory", {
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    })()
  }
  return clientPromise
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
      await Promise.all(
        userIds.map(async (id) => {
          const key = keyFor(eventId, id)
          await redis.incrBy(key, 1)
          await redis.pExpire(key, TTL_MS)
        })
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
      const values = await redis.mGet(userIds.map((id) => keyFor(eventId, id)))
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
