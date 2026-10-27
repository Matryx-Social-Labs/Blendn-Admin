/**
 * The shared limit store's two behaviours when Redis is configured and cannot
 * answer (step 12 store scan). Every limiter that predates the option fails
 * OPEN — counts in this process's memory, so a Redis blip never locks anyone
 * out of sign-in. A `failClosed` key (the offer door, offer sends) refuses,
 * and never writes to that memory: a count kept per replica drifts, and a key
 * that fell back and then recovered must not come back with a fresh budget.
 */
/** A Redis that keeps values and expiries and honours SET's NX and PX, as the real one does. */
const fake = {
  down: false,
  counts: new Map<string, number>(),
  expiresAt: new Map<string, number>(),
  /** Requests sent to Redis: a MULTI's exec is one. */
  roundTrips: 0,
  on: jest.fn(),
  connect: jest.fn(async () => undefined),
  live(key: string) {
    const at = fake.expiresAt.get(key)
    if (at !== undefined && at <= Date.now()) {
      fake.counts.delete(key)
      fake.expiresAt.delete(key)
    }
    return fake.counts.has(key)
  },
  multi() {
    const ops: Array<() => unknown> = []
    const chain = {
      set: (key: string, value: string, opts: { expiration?: { type: string; value: number }; condition?: string } = {}) => (
        ops.push(() => {
          if (opts.condition === "NX" && fake.live(key)) return null
          fake.counts.set(key, Number(value))
          if (opts.expiration?.type === "PX") fake.expiresAt.set(key, Date.now() + opts.expiration.value)
          else fake.expiresAt.delete(key)
          return "OK"
        }),
        chain
      ),
      incr: (key: string) => (ops.push(() => (fake.live(key), fake.counts.set(key, (fake.counts.get(key) ?? 0) + 1).get(key))), chain),
      pTTL: (key: string) => (
        ops.push(() => {
          if (!fake.live(key)) return -2
          const at = fake.expiresAt.get(key)
          return at === undefined ? -1 : at - Date.now()
        }),
        chain
      ),
      async exec() {
        fake.roundTrips++
        if (fake.down) throw new Error("ECONNRESET")
        return ops.map((op) => op())
      },
    }
    return chain
  },
  async get(key: string) {
    fake.roundTrips++
    if (fake.down) throw new Error("ECONNRESET")
    const n = fake.live(key) ? fake.counts.get(key) : undefined
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
  fake.expiresAt.clear()
  fake.roundTrips = 0
  resetMemoryStore()
})

describe("a hit is one round trip", () => {
  it("counts in one request to Redis, first hit and later ones alike", async () => {
    // Staging's Redis is an ocean away from the app (~165 ms a trip); two
    // sequential trips put ~330 ms on every limited request, check-in included.
    expect((await hit("rl:checkin:u1", 60_000)).count).toBe(1)
    expect(fake.roundTrips).toBe(1)
    expect((await hit("rl:checkin:u1", 60_000)).count).toBe(2)
    expect(fake.roundTrips).toBe(2)
  })
})

describe("the window, against Redis", () => {
  it("is fixed: the second hit counts 2 and keeps the first hit's reset (NX)", async () => {
    // A frozen clock: resetAt is read from two Date.now() calls around the PTTL,
    // so on a live clock it could land 1 ms short of before + 60 s and fail CI.
    const before = Date.now()
    const clock = jest.spyOn(Date, "now").mockReturnValue(before)
    try {
      const first = await hit("rl:w:u1", 60_000)
      const second = await hit("rl:w:u1", 60_000)
      expect(second.count).toBe(2)
      expect(first.resetAt).toBe(before + 60_000)
      // Not moved forward by the second hit (NX): the same reset.
      expect(second.resetAt).toBe(first.resetAt)
    } finally {
      clock.mockRestore()
    }
  })

  it("ends after windowMs and starts over (PX)", async () => {
    await hit("rl:w:u2", 20)
    await hit("rl:w:u2", 20)
    await new Promise((r) => setTimeout(r, 30))
    expect((await hit("rl:w:u2", 20)).count).toBe(1)
  })
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
