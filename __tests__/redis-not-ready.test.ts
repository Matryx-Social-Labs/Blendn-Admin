/**
 * Redis is configured and cannot answer (SCRUM-1217, launch gate 4).
 *
 * In node-redis 6 `connect()` retries for ever and never settles while Redis
 * is down, and a MULTI issued on a dropped connection bypasses both
 * `disableOfflineQueue` and the command timeout: it queues until Redis is
 * back. So the limiter and the exposure counters must never wait on either.
 * They ask `isReady` and answer from memory (fail-open) or refuse
 * (fail-closed) at once. The 2 s test timeout is the hang detector.
 */
const QUICK = 2_000

const client = {
  isReady: false,
  /** While true, every command queues for ever, as a MULTI does offline. */
  stalled: false,
  counts: new Map<string, number>(),
  on: jest.fn(),
  connect: jest.fn(() => new Promise<never>(() => {})),
  multi() {
    let key = ""
    const chain = {
      set: () => chain,
      incr: (k: string) => ((key = k), chain),
      pTTL: () => chain,
      exec: () => {
        if (client.stalled) return new Promise<never>(() => {})
        client.counts.set(key, (client.counts.get(key) ?? 0) + 1)
        return Promise.resolve([null, client.counts.get(key), 60_000])
      },
    }
    return chain
  },
  incrBy: () => new Promise<never>(() => {}),
  pExpire: () => new Promise<never>(() => {}),
  mGet: () => new Promise<never>(() => {}),
}
jest.mock("redis", () => ({ createClient: () => client }))

import { hit, hitRolling, resetMemoryStore, StoreUnavailable } from "@/lib/rate-limit-store"
import { exposuresFor, recordImpressions, resetExposureMemory } from "@/lib/exposure"

beforeAll(() => {
  process.env.REDIS_URL = "redis://down:6379"
})
afterAll(() => {
  delete process.env.REDIS_URL
})
beforeEach(() => {
  client.isReady = false
  client.stalled = false
  client.counts.clear()
  resetMemoryStore()
  resetExposureMemory()
})

describe("Redis down at boot (connect never settles)", () => {
  it("a limited route counts from memory at once", async () => {
    expect((await hit("rl:checkin:u1", 60_000)).count).toBe(1)
    expect((await hit("rl:checkin:u1", 60_000)).count).toBe(2)
    expect((await hitRolling("rl:burst:u1", 10_000, 5)).allowed).toBe(true)
  }, QUICK)

  it("a fail-closed key refuses at once", async () => {
    await expect(hit("door-fail:v1:u1", 60_000, { failClosed: true })).rejects.toBeInstanceOf(StoreUnavailable)
  }, QUICK)

  it("the match deck's exposure counts come from memory at once", async () => {
    await recordImpressions("e1", ["a", "b"])
    await recordImpressions("e1", ["a"])
    const counts = await exposuresFor("e1", ["a", "b", "c"])
    expect(Object.fromEntries(counts)).toEqual({ a: 2, b: 1, c: 0 })
  }, QUICK)
})

describe("Redis drops mid-run", () => {
  it("counts in Redis while ready, then from memory once the connection is lost", async () => {
    client.isReady = true
    expect((await hit("rl:feed:u1", 60_000)).count).toBe(1)
    expect(client.counts.get("rl:feed:u1")).toBe(1)

    // The connection is gone: node-redis reports not ready, and a MULTI sent now would queue.
    client.isReady = false
    client.stalled = true
    expect((await hit("rl:feed:u1", 60_000)).count).toBe(1)
    await expect(hit("door-fail:v1:u1", 60_000, { failClosed: true })).rejects.toBeInstanceOf(StoreUnavailable)

    // Back: counted in Redis again.
    client.isReady = true
    client.stalled = false
    expect((await hit("rl:feed:u1", 60_000)).count).toBe(2)
  }, QUICK)
})
