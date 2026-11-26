// Relative, not `@/`: `lib/push-notifications.ts` throttles bursts with `hit`,
// and it is reachable from `server.ts`, which `build:server` compiles with
// plain tsc. `__tests__/server-import-boundary.test.ts` enforces it.
import { randomUUID } from "crypto"

import { logger } from "./logger"
import { RATE_LIMIT_MAX_ENTRIES } from "./constants"

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
 * is the right amount of machinery; the chat and DM burst, whose limit is five,
 * uses `hitRolling`.
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
    return { ...fresh }
  }

  existing.count += 1
  // A copy: the stored entry keeps counting, and a caller still awaiting
  // others must see the count AS OF its own hit, as Redis answers.
  return { ...existing }
}

/* -------------------------------------------------------------------------- */
/* Redis                                                                       */
/* -------------------------------------------------------------------------- */

type RedisMulti = {
  set(key: string, value: string, options: { expiration: { type: "PX"; value: number }; condition: "NX" }): RedisMulti
  incr(key: string): RedisMulti
  pTTL(key: string): RedisMulti
  exec(): Promise<unknown[]>
}

type RedisLike = {
  multi(): RedisMulti
}

/** How long the first callers wait for a healthy Redis to connect. */
const CONNECT_GRACE_MS = 250
/** Longest a limited request waits on one Redis command (staging's round trip is ~165 ms). */
const COMMAND_BOUND_MS = 500
/** After a command overruns the bound, how long Redis is left alone before it is asked again. */
const STALL_BACKOFF_MS = 5_000
/** A PING this often, so a connection the path dropped is written to, noticed and reconnected. */
const PING_INTERVAL_MS = 10_000

let client: (RedisLike & { isReady: boolean }) | null = null
let starting: Promise<void> | null = null
let stalledUntil = 0

/**
 * The client when it can answer now, else null, and never a wait on Redis.
 * In node-redis 6 `connect()` retries for ever while Redis is down, and a
 * MULTI sent on a dropped connection bypasses `disableOfflineQueue` and the
 * command timeout and queues until Redis is back. So `connect()` is started
 * once and not awaited, and a client that is not ready is not used: the
 * caller counts in memory (fail-open) or refuses (fail-closed) at once.
 */
async function getRedis(): Promise<RedisLike | null> {
  const url = process.env.REDIS_URL
  if (!url) return null
  starting ??= startRedis(url)
  await starting
  return client?.isReady && Date.now() >= stalledUntil ? client : null
}

/**
 * One Redis command, or a rejection after COMMAND_BOUND_MS. A Redis that
 * stalls with its socket open (a paused or swapping process, a path dropping
 * packets without a reset) still reads `isReady`, and in node-redis 6.2 a
 * MULTI has no command timeout at all, so without this a stall holds every
 * limited request (SCRUM-1378). An overrun also stops `getRedis` handing out
 * the client for STALL_BACKOFF_MS, so a stall costs one bound per back-off,
 * not one per request. The callers' catch blocks fall back as for any error.
 *
 * The abandoned command still runs if Redis resumes, so a hit can be counted
 * both here in memory and later in Redis. Over-counting is the safe side.
 * `Promise.race` keeps a handler on it, so its late rejection is not unhandled.
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
    logger.error("Rate limit Redis unavailable, using in-process counters", {
      error: error instanceof Error ? error.message : String(error),
    })
  try {
    const { createClient } = await import("redis")
    const created = createClient({ url, pingInterval: PING_INTERVAL_MS })
    // Without a handler an emitted 'error' is an unhandled exception that
    // takes the process down — a rate limiter must never do that.
    created.on("error", (error: unknown) => {
      logger.warn("Rate limit Redis error", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    const ready = new Promise<void>((resolve) =>
      created.on("ready", () => {
        logger.info("Rate limiting backed by Redis")
        resolve()
      })
    )
    created.connect().catch(unavailable)
    client = created as unknown as RedisLike & { isReady: boolean }
    // The first callers give a healthy Redis a moment to connect, so a
    // fail-closed key is not refused in the few ms after every boot. Bounded:
    // a Redis down at boot costs this once per process, never a hang.
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, CONNECT_GRACE_MS).unref())])
  } catch (error) {
    unavailable(error)
  }
}

/**
 * Record a hit and return the current count for the window.
 *
 * Degrades to the in-process counter if Redis is unreachable. That is
 * deliberate: a Redis outage should weaken limits to per-replica, not remove
 * them, and it certainly should not fail requests. Failing open entirely would
 * hand an attacker a way to disable every limit by taking Redis down.
 */
/**
 * How a limiter behaves when Redis is configured and cannot answer.
 *
 * Fail-open (the default, every limiter that predates this): count in this
 * process's memory instead, so a Redis blip never locks anyone out of sign-in.
 *
 * Fail-closed (`{ failClosed: true }`, step 12: the offer door and offer
 * sends): refuse by throwing `StoreUnavailable`, and NEVER touch the
 * in-process map — each replica would keep its own count and a restart would
 * reset it, so a key that fell back and later recovered could come back with
 * a fresh budget. A fail-closed key lives in Redis or nowhere. With no
 * REDIS_URL at all there is one store, this process's, for every key alike.
 */
export interface StoreOptions {
  failClosed?: boolean
}

export class StoreUnavailable extends Error {}

/** Redis for a fail-closed key, or the reason it cannot be had. */
async function redisFor(key: string, opts: StoreOptions): Promise<RedisLike | null> {
  const redis = await getRedis()
  if (!redis && opts.failClosed && process.env.REDIS_URL) {
    logger.warn("Fail-closed limiter refused: rate limit store unavailable", { key })
    throw new StoreUnavailable("rate limit store unavailable")
  }
  return redis
}

export async function hit(key: string, windowMs: number, opts: StoreOptions = {}): Promise<HitResult> {
  const now = Date.now()
  const redis = await redisFor(key, opts)
  if (!redis) return hitMemory(key, windowMs, now)

  try {
    /*
     * One round trip, not two. This was INCR, then PEXPIRE or PTTL — two
     * sequential trips on every limited request — and staging's Redis is in
     * us-west2 while the app is in asia-southeast1: ~165 ms a trip, measured
     * as ~330 ms on every check-in (and every other limited route) before the
     * route did any work of its own.
     *
     * SET NX PX starts the window only when the key is new, so it stays fixed
     * rather than sliding forward with every request (a steady caller would
     * otherwise never reset); INCR keeps the TTL. MULTI makes the three atomic.
     */
    const [, count, ttl] = (await bounded(
      redis
        .multi()
        .set(key, "0", { expiration: { type: "PX", value: windowMs }, condition: "NX" })
        .incr(key)
        .pTTL(key)
        .exec()
    )) as [unknown, number, number]
    return { count, resetAt: now + (ttl > 0 ? ttl : windowMs) }
  } catch (error) {
    if (opts.failClosed) {
      logger.warn("Fail-closed limiter refused: Redis hit failed", { key, error: error instanceof Error ? error.message : String(error) })
      throw new StoreUnavailable("rate limit store unavailable")
    }
    logger.warn("Rate limit Redis hit failed, falling back to memory", {
      error: error instanceof Error ? error.message : String(error),
    })
    return hitMemory(key, windowMs, now)
  }
}

export interface RollingResult {
  allowed: boolean
  /** When the next one would be allowed (epoch ms). Set only on a refusal. */
  retryAt?: number
}

const rolling = new Map<string, number[]>()

function hitRollingMemory(key: string, windowMs: number, limit: number, now: number): RollingResult {
  const inWindow = (rolling.get(key) ?? []).filter((t) => t > now - windowMs)
  if (inWindow.length >= limit) return { allowed: false, retryAt: inWindow[0] + windowMs }
  // Re-inserted, so the map's first key is the one hit longest ago, and it is the one evicted.
  rolling.delete(key)
  if (rolling.size >= RATE_LIMIT_MAX_ENTRIES) {
    const oldest = rolling.keys().next().value
    if (oldest !== undefined) rolling.delete(oldest)
  }
  rolling.set(key, [...inWindow, now])
  return { allowed: true }
}

/*
 * Trim, count, add: one script, so two sends at once cannot both be the fifth.
 * Redis's own clock, so replicas agree. Answers 0 when allowed, else the epoch
 * ms of the oldest one still in the window.
 */
const ROLLING_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2]
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return '0'`

/**
 * At most `limit` in ANY `windowMs`, where `hit`'s fixed window lets twice the
 * limit pass across its edge. Only what is allowed is remembered, so retrying
 * while refused never pushes `retryAt` out. For a small limit on a hot key (the
 * chat and DM burst): it keeps up to `limit` entries per key. Falls back to this
 * process's memory when Redis cannot answer, as `hit` does.
 */
export async function hitRolling(key: string, windowMs: number, limit: number): Promise<RollingResult> {
  const now = Date.now()
  const redis = await getRedis()
  if (!redis) return hitRollingMemory(key, windowMs, limit, now)
  try {
    const oldest = Number(
      await bounded(
        (redis as unknown as { eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown> }).eval(ROLLING_SCRIPT, {
          keys: [key],
          arguments: [String(windowMs), String(limit), randomUUID()],
        })
      )
    )
    return oldest === 0 ? { allowed: true } : { allowed: false, retryAt: oldest + windowMs }
  } catch (error) {
    logger.warn("Rate limit Redis rolling hit failed, falling back to memory", {
      error: error instanceof Error ? error.message : String(error),
    })
    return hitRollingMemory(key, windowMs, limit, now)
  }
}

/**
 * The count a key holds now, without adding to it; zero when it has none or
 * its window has passed. Same rules as `hit`, `failClosed` included.
 */
export async function peek(key: string, opts: StoreOptions = {}): Promise<number> {
  const redis = await redisFor(key, opts)
  if (redis) {
    try {
      const value = await bounded((redis as unknown as { get(k: string): Promise<string | null> }).get(key))
      return value ? Number(value) || 0 : 0
    } catch (error) {
      if (opts.failClosed) {
        logger.warn("Fail-closed limiter refused: Redis read failed", { key, error: error instanceof Error ? error.message : String(error) })
        throw new StoreUnavailable("rate limit store unavailable")
      }
      logger.warn("Rate limit Redis peek failed, falling back to memory", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const existing = memory.get(key)
  return existing && Date.now() <= existing.resetAt ? existing.count : 0
}

/**
 * Give back one hit: for a caller that reserves before it knows the outcome
 * (`hit`, do the work, `release` on success), so that concurrent callers cannot
 * all read "under the cap" before any of them counts. Never goes below zero and
 * never creates a key: a Redis `DECR` on an expired key would make a counter
 * with no TTL at -1 that never expires. Best-effort -- a failed release leaves
 * the count one high, which is the safe side.
 */
export async function release(key: string): Promise<void> {
  const redis = await getRedis()
  if (redis) {
    try {
      await bounded(
        (redis as unknown as { eval(script: string, opts: { keys: string[] }): Promise<unknown> }).eval(
          "local n = redis.call('GET', KEYS[1]) if n and tonumber(n) > 0 then return redis.call('DECR', KEYS[1]) end return 0",
          { keys: [key] }
        )
      )
      return
    } catch (error) {
      logger.warn("Rate limit Redis release failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const existing = memory.get(key)
  if (existing && Date.now() <= existing.resetAt && existing.count > 0) existing.count -= 1
}

export function resetMemoryStore(): void {
  memory.clear()
  rolling.clear()
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
  rolling.delete(key)
  const redis = await getRedis()
  if (!redis) return
  try {
    await bounded((redis as unknown as { del(k: string): Promise<unknown> }).del(key))
  } catch (error) {
    logger.warn("Rate limit Redis delete failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
