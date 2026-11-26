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
  /** While set, every MULTI rejects this many ms after it was sent (a socket closing late). */
  rejectAfterMs: 0,
  multiCalls: 0,
  mGetCalls: 0,
  /** What each store passed to createClient. */
  options: [] as unknown[],
  counts: new Map<string, number>(),
  listeners: new Map<string, () => void>(),
  on(event: string, fn: () => void) {
    mockClient.listeners.set(event, fn)
  },
  connect: jest.fn(never),
  multi() {
    mockClient.multiCalls += 1
    let key = ""
    const chain = {
      set: () => chain,
      incr: (k: string) => ((key = k), chain),
      pTTL: () => chain,
      exec: () => {
        if (mockClient.rejectAfterMs) {
          const ms = mockClient.rejectAfterMs
          return new Promise((_, reject) => setTimeout(() => reject(new Error("Socket closed unexpectedly")), ms))
        }
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
  mGet: (keys: string[]) => {
    mockClient.mGetCalls += 1
    return mockClient.stalled ? never() : Promise.resolve(keys.map(() => "1"))
  },
}
jest.mock("redis", () => ({
  createClient: (options: unknown) => {
    mockClient.options.push(options)
    return mockClient
  },
}))

type Store = typeof import("@/lib/rate-limit-store")
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
  mockClient.rejectAfterMs = 0
  mockClient.multiCalls = 0
  mockClient.mGetCalls = 0
  mockClient.options = []
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

/*
 * A Redis that stalls with the socket open (SCRUM-1378): a paused or swapping
 * process, a path that drops packets without a reset. node-redis still reads
 * `isReady`, and in 6.2.1 a MULTI carries no command timeout at all (a plain
 * command's default is 5 s), so the wait is bounded here. "Inside the bound"
 * is asserted as under 1 s, the bound being a few hundred ms; the 2 s test
 * timeout is still the hang detector.
 */
describe("Redis stalls with the socket open (isReady stays true)", () => {
  // Wide enough for a loaded host; still far under the 2 s hang detector and node-redis's own 5 s.
  const BOUND_SLACK = 1_500
  const STALL_TIMEOUT = 3_000
  const timed = async <T>(work: () => Promise<T>) => {
    const started = Date.now()
    const result = await work()
    return { result, ms: Date.now() - started }
  }

  beforeEach(() => {
    mockClient.isReady = true
    mockClient.stalled = true
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("a limited route answers from memory inside the bound", async () => {
    const { store } = await load()
    const { result, ms } = await timed(() => store.hit("rl:checkin:u1", 60_000))
    expect(result.count).toBe(1)
    expect(ms).toBeLessThan(BOUND_SLACK)
  }, STALL_TIMEOUT)

  it("a fail-closed key refuses inside the bound", async () => {
    const { store } = await load()
    const started = Date.now()
    await expect(store.hit("door-fail:v1:u1", 60_000, { failClosed: true })).rejects.toBeInstanceOf(store.StoreUnavailable)
    expect(Date.now() - started).toBeLessThan(BOUND_SLACK)
  }, STALL_TIMEOUT)

  // Each on a fresh process: the first overrun trips the back-off, and a later
  // command would then never reach the stalled Redis at all.
  it.each<[string, (s: Store) => Promise<unknown>]>([
    ["hitRolling", (s: Store) => s.hitRolling("rl:burst:u1", 10_000, 5)],
    ["peek", (s: Store) => s.peek("rl:checkin:u1")],
    ["release", (s: Store) => s.release("rl:checkin:u1")],
    ["forget", (s: Store) => s.forget("rl:checkin:u1")],
  ])("%s is bounded too", async (_name, command) => {
    const { store } = await load()
    const { ms } = await timed(() => command(store))
    expect(ms).toBeLessThan(BOUND_SLACK)
  }, STALL_TIMEOUT)

  it("once one command has timed out, the next callers do not ask Redis at all", async () => {
    const { store } = await load()
    await store.hit("rl:feed:u1", 60_000)
    expect(mockClient.multiCalls).toBe(1)

    expect((await store.hit("rl:feed:u1", 60_000)).count).toBe(2)
    await expect(store.hit("door-fail:v1:u1", 60_000, { failClosed: true })).rejects.toBeInstanceOf(store.StoreUnavailable)
    expect(await store.peek("rl:feed:u1")).toBe(2)
    expect(mockClient.multiCalls).toBe(1)
  }, STALL_TIMEOUT)

  it("after the back-off, Redis is asked again and counts again once it answers", async () => {
    const { store } = await load()
    await store.hit("rl:feed:u1", 60_000)
    mockClient.stalled = false
    const later = Date.now() + 60_000
    jest.spyOn(Date, "now").mockImplementation(() => later)

    expect((await store.hit("rl:feed:u1", 60_000)).count).toBe(1)
    expect(mockClient.counts.get("rl:feed:u1")).toBe(1)
  }, STALL_TIMEOUT)

  it("a healthy command clears its timer: a later call still counts in Redis", async () => {
    mockClient.stalled = false
    const { store } = await load()
    await store.hit("rl:feed:u1", 60_000)
    await new Promise((r) => setTimeout(r, 700))
    expect((await store.hit("rl:feed:u1", 60_000)).count).toBe(2)
    expect(mockClient.counts.get("rl:feed:u1")).toBe(2)
  }, STALL_TIMEOUT)

  it("a healthy exposure read clears its timer: a later read still asks Redis", async () => {
    mockClient.stalled = false
    const { exposure } = await load()
    await exposure.exposuresFor("e1", ["a"])
    await new Promise((r) => setTimeout(r, 700))
    expect((await exposure.exposuresFor("e1", ["a"])).get("a")).toBe(1)
    expect(mockClient.mGetCalls).toBe(2)
  }, STALL_TIMEOUT)

  it("both clients PING, so an idle connection the path dropped is noticed", async () => {
    const { store, exposure } = await load()
    await store.hit("rl:feed:u1", 60_000)
    await exposure.exposuresFor("e1", ["a"])
    expect(mockClient.options).toHaveLength(2)
    for (const options of mockClient.options) expect(options).toEqual(expect.objectContaining({ pingInterval: expect.any(Number) }))
  }, STALL_TIMEOUT)

  it("after one exposure read times out, the next does not ask Redis", async () => {
    const { exposure } = await load()
    await exposure.exposuresFor("e1", ["a"])
    expect(mockClient.mGetCalls).toBe(1)
    const read = await timed(() => exposure.exposuresFor("e1", ["a"]))
    expect(read.result.get("a")).toBe(0)
    expect(mockClient.mGetCalls).toBe(1)
  }, STALL_TIMEOUT)

  it("an abandoned MULTI that rejects later is not an unhandled rejection", async () => {
    mockClient.stalled = false
    mockClient.rejectAfterMs = 1_200
    const unhandled = jest.fn()
    process.on("unhandledRejection", unhandled)
    try {
      const { store } = await load()
      expect((await store.hit("rl:feed:u1", 60_000)).count).toBe(1)
      await new Promise((r) => setTimeout(r, 1_300))
      await new Promise((r) => setImmediate(r))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", unhandled)
    }
  }, 3_000)

  it("the match deck's exposure reads and writes answer inside the bound", async () => {
    const { exposure } = await load()
    const write = await timed(() => exposure.recordImpressions("e1", ["a", "b"]))
    expect(write.ms).toBeLessThan(BOUND_SLACK)
    const read = await timed(() => exposure.exposuresFor("e1", ["a", "b"]))
    expect(Object.fromEntries(read.result)).toEqual({ a: 0, b: 0 })
    expect(read.ms).toBeLessThan(BOUND_SLACK)
  }, STALL_TIMEOUT)

  it("the exposure read alone, on a fresh process, answers inside the bound", async () => {
    const { exposure } = await load()
    const read = await timed(() => exposure.exposuresFor("e1", ["a"]))
    expect(read.result.get("a")).toBe(0)
    expect(read.ms).toBeLessThan(BOUND_SLACK)
  }, STALL_TIMEOUT)
})
