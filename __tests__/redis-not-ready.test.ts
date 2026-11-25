/**
 * Redis is configured and cannot answer (SCRUM-1217, launch gate 4).
 *
 * In node-redis 6 `connect()` retries for ever and never settles while Redis
 * is down, and a MULTI issued on a dropped connection bypasses both
 * `disableOfflineQueue` and the command timeout: it queues until Redis is
 * back. So the limiter and the exposure counters must never wait on either.
 * They ask `isReady` and answer from memory (fail-open) or refuse
 * (fail-closed) at once. The 2 s test timeout is the hang detector.
 *
 * Each test loads the stores afresh: the client is module state, made once.
 */
const QUICK = 2_000
const never = () => new Promise<never>(() => {})

const mockClient = {
  isReady: false,
  /** While true, every MULTI queues for ever, as one does offline. */
  stalled: false,
  counts: new Map<string, number>(),
  listeners: new Map<string, () => void>(),
  on(event: string, fn: () => void) {
    mockClient.listeners.set(event, fn)
  },
  connect: jest.fn(never),
  multi() {
    let key = ""
    const chain = {
      set: () => chain,
      incr: (k: string) => ((key = k), chain),
      pTTL: () => chain,
      exec: () => {
        if (mockClient.stalled) return never()
        mockClient.counts.set(key, (mockClient.counts.get(key) ?? 0) + 1)
        return Promise.resolve([null, mockClient.counts.get(key), 60_000])
      },
    }
    return chain
  },
  // Every other command a store could send: none may be reached while not ready.
  get: never,
  eval: never,
  del: never,
  incrBy: never,
  pExpire: never,
  mGet: never,
}
jest.mock("redis", () => ({ createClient: () => mockClient }))

const load = async () => ({ store: await import("@/lib/rate-limit-store"), exposure: await import("@/lib/exposure") })

beforeAll(() => {
  process.env.REDIS_URL = "redis://down:6379"
})
afterAll(() => {
  delete process.env.REDIS_URL
})
beforeEach(() => {
  jest.resetModules()
  mockClient.isReady = false
  mockClient.stalled = false
  mockClient.counts.clear()
  mockClient.listeners.clear()
  mockClient.connect.mockImplementation(never)
})

describe("Redis down at boot (connect never settles)", () => {
  it("a limited route counts from memory at once, and nothing reaches Redis", async () => {
    const { store } = await load()
    expect((await store.hit("rl:checkin:u1", 60_000)).count).toBe(1)
    expect((await store.hit("rl:checkin:u1", 60_000)).count).toBe(2)
    expect((await store.hitRolling("rl:burst:u1", 10_000, 5)).allowed).toBe(true)
    expect(await store.peek("rl:checkin:u1")).toBe(2)
    await store.release("rl:checkin:u1")
    expect(await store.peek("rl:checkin:u1")).toBe(1)
    await store.forget("rl:checkin:u1")
    expect(await store.peek("rl:checkin:u1")).toBe(0)
  }, QUICK)

  it("a fail-closed key refuses at once", async () => {
    const { store } = await load()
    await expect(store.hit("door-fail:v1:u1", 60_000, { failClosed: true })).rejects.toBeInstanceOf(store.StoreUnavailable)
    await expect(store.peek("door-fail:v1:u1", { failClosed: true })).rejects.toBeInstanceOf(store.StoreUnavailable)
  }, QUICK)

  it("the match deck's exposure counts come from memory at once", async () => {
    const { exposure } = await load()
    await exposure.recordImpressions("e1", ["a", "b"])
    await exposure.recordImpressions("e1", ["a"])
    const counts = await exposure.exposuresFor("e1", ["a", "b", "c"])
    expect(Object.fromEntries(counts)).toEqual({ a: 2, b: 1, c: 0 })
  }, QUICK)
})

describe("connect() rejects (a client that will not retry)", () => {
  it("is caught: no unhandled rejection, and both stores count in memory", async () => {
    mockClient.connect.mockImplementation(() => Promise.reject(new Error("WRONGPASS")))
    const unhandled = jest.fn()
    process.on("unhandledRejection", unhandled)
    try {
      const { store, exposure } = await load()
      expect((await store.hit("rl:feed:u1", 60_000)).count).toBe(1)
      await exposure.recordImpressions("e1", ["a"])
      expect((await exposure.exposuresFor("e1", ["a"])).get("a")).toBe(1)
      await new Promise((r) => setImmediate(r))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", unhandled)
    }
  }, QUICK)
})

describe("a healthy Redis at boot", () => {
  it("is waited for briefly, so the first fail-closed key is counted, not refused", async () => {
    mockClient.connect.mockImplementation(async () => {
      setTimeout(() => {
        mockClient.isReady = true
        mockClient.listeners.get("ready")?.()
      }, 20)
      return undefined as never
    })
    const { store } = await load()
    expect((await store.hit("door-fail:v1:u1", 60_000, { failClosed: true })).count).toBe(1)
    expect(mockClient.counts.get("door-fail:v1:u1")).toBe(1)
  }, QUICK)
})

describe("Redis drops mid-run", () => {
  it("counts in Redis while ready, then from memory once the connection is lost", async () => {
    mockClient.isReady = true
    const { store } = await load()
    expect((await store.hit("rl:feed:u1", 60_000)).count).toBe(1)
    expect(mockClient.counts.get("rl:feed:u1")).toBe(1)

    // The connection is gone: node-redis reports not ready, and a MULTI sent now would queue.
    mockClient.isReady = false
    mockClient.stalled = true
    expect((await store.hit("rl:feed:u1", 60_000)).count).toBe(1)
    await expect(store.hit("door-fail:v1:u1", 60_000, { failClosed: true })).rejects.toBeInstanceOf(store.StoreUnavailable)

    // Back: counted in Redis again.
    mockClient.isReady = true
    mockClient.stalled = false
    expect((await store.hit("rl:feed:u1", 60_000)).count).toBe(2)
  }, QUICK)
})
