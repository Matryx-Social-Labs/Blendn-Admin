import { forget, hit, hitRolling, release, resetMemoryStore } from "@/lib/rate-limit-store"

/**
 * The counter behind every limit.
 *
 * The property that matters most is not "it counts" but **what it does when
 * Redis is gone**. Failing open entirely would hand an attacker a way to
 * disable every limit in the product by taking one dependency down; failing
 * closed would turn a Redis blip into a total outage. It degrades to
 * per-process counting instead — weaker, still a limit, requests still served.
 *
 * These run without `REDIS_URL`, which is the fallback path.
 */

beforeEach(() => resetMemoryStore())

describe("hit", () => {
  it("counts within a window", async () => {
    const key = "test:count"
    expect((await hit(key, 60_000)).count).toBe(1)
    expect((await hit(key, 60_000)).count).toBe(2)
    expect((await hit(key, 60_000)).count).toBe(3)
  })

  it("answers each concurrent hit with the count as of that hit", async () => {
    // Redis does; the in-process store returned its live entry, so every parallel caller
    // saw the final count and a check-by-increment refused them all.
    const counts = (await Promise.all(Array.from({ length: 5 }, () => hit("test:parallel", 60_000)))).map((r) => r.count)
    expect(counts.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it("release gives one hit back, never goes below zero and never creates a key", async () => {
    await hit("test:release", 60_000)
    await hit("test:release", 60_000)
    await release("test:release")
    expect((await hit("test:release", 60_000)).count).toBe(2)
    await release("test:never-hit")
    expect((await hit("test:never-hit", 60_000)).count).toBe(1)
    await release("test:release"); await release("test:release"); await release("test:release")
    expect((await hit("test:release", 60_000)).count).toBe(1)
  })

  it("keeps separate keys separate", async () => {
    // Buckets are namespaced per endpoint and per user; a shared counter would
    // mean one user's activity rate-limiting another's.
    expect((await hit("a", 60_000)).count).toBe(1)
    expect((await hit("b", 60_000)).count).toBe(1)
  })

  it("resets after the window elapses", async () => {
    const key = "test:expiry"
    await hit(key, 20)
    await hit(key, 20)
    await new Promise((r) => setTimeout(r, 30))
    // A fixed window: the count starts over rather than sliding, so a steady
    // caller is never permanently locked out.
    expect((await hit(key, 20)).count).toBe(1)
  })

  it("reports a resetAt in the future so Retry-After is never zero or negative", async () => {
    const before = Date.now()
    const { resetAt } = await hit("test:reset", 60_000)
    expect(resetAt).toBeGreaterThan(before)
  })

  it("keeps resetAt stable across hits in the same window", async () => {
    // If the deadline moved forward on every request, a caller making steady
    // traffic would never see the window end.
    const first = await hit("test:stable", 60_000)
    const second = await hit("test:stable", 60_000)
    expect(second.resetAt).toBe(first.resetAt)
  })

  it("serves requests when there is no Redis rather than erroring", async () => {
    // The whole point of the fallback: no REDIS_URL is the normal single
    // replica case, not a failure.
    delete process.env.REDIS_URL
    await expect(hit("test:noredis", 60_000)).resolves.toBeDefined()
  })
})

describe("hitRolling: at most N in any window, not N per fixed window", () => {
  const T = 1_900_000_000_000
  const at = (ms: number) => jest.spyOn(Date, "now").mockReturnValue(T + ms)
  afterEach(() => jest.restoreAllMocks())

  it("holds across a fixed window's edge, where twice the limit used to pass", async () => {
    // Five late in one ten-second window, then five early in the next.
    for (let i = 0; i < 5; i++) {
      at(9_000 + i * 100)
      expect((await hitRolling("roll:edge", 10_000, 5)).allowed).toBe(true)
    }
    at(11_000)
    expect(await hitRolling("roll:edge", 10_000, 5)).toEqual({ allowed: false, retryAt: T + 19_000 })
    // The first of the five leaves the window at 19 s: one more, and only one.
    at(19_001)
    expect((await hitRolling("roll:edge", 10_000, 5)).allowed).toBe(true)
    at(19_001)
    expect((await hitRolling("roll:edge", 10_000, 5)).allowed).toBe(false)
  })

  it("a refused try is not counted, so retrying never pushes the wait out", async () => {
    for (let i = 0; i < 5; i++) {
      at(i)
      await hitRolling("roll:retry", 10_000, 5)
    }
    for (let i = 0; i < 20; i++) {
      at(5_000 + i)
      expect(await hitRolling("roll:retry", 10_000, 5)).toEqual({ allowed: false, retryAt: T + 10_000 })
    }
    at(10_001)
    expect((await hitRolling("roll:retry", 10_000, 5)).allowed).toBe(true)
  })

  it("admits exactly the limit of many at once, keeps keys apart, and is forgotten", async () => {
    const all = await Promise.all(Array.from({ length: 12 }, () => hitRolling("roll:many", 10_000, 5)))
    expect(all.filter((r) => r.allowed)).toHaveLength(5)
    expect((await hitRolling("roll:other", 10_000, 5)).allowed).toBe(true)
    await forget("roll:many")
    expect((await hitRolling("roll:many", 10_000, 5)).allowed).toBe(true)
  })
})
