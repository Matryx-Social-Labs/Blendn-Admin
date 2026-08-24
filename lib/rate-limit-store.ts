import { logger } from "@/lib/logger"
import { RATE_LIMIT_MAX_ENTRIES } from "@/lib/constants"

/**
 * Where rate-limit counters live.
 *
 * Redis when `REDIS_URL` is set, an in-process Map otherwise. The Map is not a
 * toy fallback — it is what runs today at one replica and it is correct there.
 * What it cannot do is share a bucket across replicas, so a limit of 30/min
 * silently becomes 30/min *per instance* the moment you scale, and the more
 * replicas you add the weaker every limit gets.
 *
 * Counting is a fixed window: INCR, and set the TTL on the first hit. A sliding
 * window would be more precise at the boundary — a caller can burst twice the
 * limit across a window edge — but it needs a sorted set per key and a trim on
 * every request. For "stop one account hammering an endpoint", the fixed window
 * is the right amount of machinery.
 */

export interface HitResult {
  count: number
  resetAt: number
}

/* -------------------------------------------------------------------------- */
/* In-process fallback                                                         */
/* -------------------------------------------------------------------------- */

const memory = new Map<string, HitResult>()

function hitMemory(key: string, windowMs: number, now: number): HitResult {
  const existing = memory.get(key)

  if (!existing || now > existing.resetAt) {
    if (memory.size >= RATE_LIMIT_MAX_ENTRIES) {
      for (const [k, v] of memory) if (now > v.resetAt) memory.delete(k)
      if (memory.size >= RATE_LIMIT_MAX_ENTRIES) {
        const oldest = memory.keys().next().value
        if (oldest) memory.delete(oldest)
      }
    }
    const fresh = { count: 1, resetAt: now + windowMs }
    memory.set(key, fresh)
    return fresh
  }

  existing.count += 1
  return existing
}

/* -------------------------------------------------------------------------- */
/* Redis                                                                       */
/* -------------------------------------------------------------------------- */

type RedisLike = {
  incr(key: string): Promise<number>
  pExpire(key: string, ms: number): Promise<unknown>
  pTTL(key: string): Promise<number>
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
        // Without a handler an emitted 'error' is an unhandled exception that
        // takes the process down — a rate limiter must never do that.
        client.on("error", (error: unknown) => {
          logger.warn("Rate limit Redis error", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
        await client.connect()
        logger.info("Rate limiting backed by Redis")
        return client as unknown as RedisLike
      } catch (error) {
        logger.error("Rate limit Redis unavailable, using in-process counters", {
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    })()
  }

  return clientPromise
}

/**
 * Record a hit and return the current count for the window.
 *
 * Degrades to the in-process counter if Redis is unreachable. That is
 * deliberate: a Redis outage should weaken limits to per-replica, not remove
 * them, and it certainly should not fail requests. Failing open entirely would
 * hand an attacker a way to disable every limit by taking Redis down.
 */
export async function hit(key: string, windowMs: number): Promise<HitResult> {
  const now = Date.now()
  const redis = await getRedis()
  if (!redis) return hitMemory(key, windowMs, now)

  try {
    const count = await redis.incr(key)
    if (count === 1) {
      // Only on the first hit, so the window is fixed rather than sliding
      // forward with every request — otherwise a steady caller would never
      // reset and would be locked out permanently.
      await redis.pExpire(key, windowMs)
      return { count, resetAt: now + windowMs }
    }
    const ttl = await redis.pTTL(key)
    return { count, resetAt: now + (ttl > 0 ? ttl : windowMs) }
  } catch (error) {
    logger.warn("Rate limit Redis hit failed, falling back to memory", {
      error: error instanceof Error ? error.message : String(error),
    })
    return hitMemory(key, windowMs, now)
  }
}

/** Test seam — clears the in-process counters. */
export function resetMemoryStore(): void {
  memory.clear()
}

/**
 * Forget one key's window.
 *
 * A test seam, and a real one: any caller that keeps state of its own beside a
 * counter here has to be able to reset both together, or a "reset" clears half
 * the state and the next test inherits the other half. The spam detector hit
 * exactly that when its burst counter moved out of its own Map.
 *
 * Best-effort against Redis. Failing to forget a 10-second window is not worth
 * propagating an error for.
 */
export async function forget(key: string): Promise<void> {
  memory.delete(key)
  const redis = await getRedis()
  if (!redis) return
  try {
    await (redis as unknown as { del(k: string): Promise<unknown> }).del(key)
  } catch (error) {
    logger.warn("Rate limit Redis delete failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
