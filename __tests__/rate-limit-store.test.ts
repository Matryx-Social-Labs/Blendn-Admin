import { hit, resetMemoryStore } from "@/lib/rate-limit-store"

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
