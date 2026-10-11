/**
 * The shared limit store's two behaviours when Redis is configured and cannot
 * answer (step 12 store scan). Every limiter that predates the option fails
 * OPEN — counts in this process's memory, so a Redis blip never locks anyone
 * out of sign-in. A `failClosed` key (the offer door, offer sends) refuses,
 * and never writes to that memory: a count kept per replica drifts, and a key
 * that fell back and then recovered must not come back with a fresh budget.
 */
const fake = {
  down: false,
  counts: new Map<string, number>(),
  on: jest.fn(),
  connect: jest.fn(async () => undefined),
  async incr(key: string) {
    if (fake.down) throw new Error("ECONNRESET")
    const n = (fake.counts.get(key) ?? 0) + 1
    fake.counts.set(key, n)
    return n
  },
  async pExpire() {
    if (fake.down) throw new Error("ECONNRESET")
    return 1
  },
  async pTTL() {
    if (fake.down) throw new Error("ECONNRESET")
    return 60_000
  },
  async get(key: string) {
    if (fake.down) throw new Error("ECONNRESET")
    const n = fake.counts.get(key)
    return n === undefined ? null : String(n)
  },
}
jest.mock("redis", () => ({ createClient: () => fake }))

import { hit, peek, resetMemoryStore, StoreUnavailable } from "@/lib/rate-limit-store"

beforeAll(() => {
  process.env.REDIS_URL = "redis://fake:6379"
})
afterAll(() => {
  delete process.env.REDIS_URL
})
beforeEach(() => {
  fake.down = false
  fake.counts.clear()
  resetMemoryStore()
})

describe("with Redis down", () => {
  it("a fail-closed limiter refuses while a fail-open one (sign-in) still allows", async () => {
    fake.down = true
    await expect(hit("door-fail:v1:u1", 60_000, { failClosed: true })).rejects.toBeInstanceOf(StoreUnavailable)
    await expect(peek("door-fail:v1:u1", { failClosed: true })).rejects.toBeInstanceOf(StoreUnavailable)
    // The sign-in limiter's shape: no option, so the old behaviour — a count from memory.
    expect((await hit("rl:signin:203.0.113.9", 60_000)).count).toBe(1)
  })
})

describe("a fail-closed key never lives in memory", () => {
  it("keeps its count through an outage and a recovery: no fresh budget", async () => {
    for (let i = 0; i < 9; i++) await hit("door-fail:v1:u1", 300_000, { failClosed: true })
    fake.down = true
    // Refused during the outage, and nothing written to this process's map for the key.
    await expect(hit("door-fail:v1:u1", 300_000, { failClosed: true })).rejects.toBeInstanceOf(StoreUnavailable)
    expect(await peek("door-fail:v1:u1")).toBe(0) // fail-open read of memory: never written
    fake.down = false
    // Back: the tenth wrong code is the tenth, not the first.
    expect((await hit("door-fail:v1:u1", 300_000, { failClosed: true })).count).toBe(10)
    expect(await peek("door-fail:v1:u1", { failClosed: true })).toBe(10)
  })
})
