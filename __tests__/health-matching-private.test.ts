/**
 * SCRUM-946 (owner row 20, decided by lean 2026-10-31; reverse if wanted): `/api/health` is public, unlimited and uncached,
 * and Railway reads only its status code. It no longer carries product metrics: the matching coverage (how many people who
 * turned up can be ranked) moved to `/api/health/matching`, which answers an app admin only.
 */
const mockCurrentUser = jest.fn()
const mockCoverage = jest.fn()
jest.mock("@/lib/current-user", () => ({ currentUser: () => mockCurrentUser() }))
const mockPoolStats = jest.fn()
jest.mock("@/lib/db", () => ({
  db: { $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]) },
  poolStats: () => mockPoolStats(),
}))
jest.mock("@/lib/interest-coverage", () => ({ MIN_INTERESTS_TO_RANK: 3, interestCoverage: () => mockCoverage() }))
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import { GET as health } from "@/app/api/health/route"
import { GET as matching } from "@/app/api/health/matching/route"

beforeEach(() => {
  jest.clearAllMocks()
  mockCoverage.mockResolvedValue({ status: "ok", attendees: 10, rankable: 9, minInterestsToRank: 3 })
  mockPoolStats.mockReturnValue({ total: 4, idle: 1, waiting: 2 })
  globalThis.__blendnSocketIo = undefined
})

it("the public health body is infrastructure only: no matching coverage, and the query is never run", async () => {
  const res = await health()
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toMatchObject({ status: "ok", database: "connected" })
  expect(body).not.toHaveProperty("matching")
  expect(mockCoverage).not.toHaveBeenCalled()
})

/*
 * SCRUM-1221: the numbers ops/07 alerts on, as counts only (the endpoint is public). `pool.waiting` > 0 is requests
 * queued for a connection; `eventLoopDelayMs.p99` > 100 is the one process saturating, which `SELECT 1` never shows.
 */
it("reports the pool, the event-loop delay and the socket count, as numbers", async () => {
  globalThis.__blendnSocketIo = { engine: { clientsCount: 7 } } as unknown as typeof globalThis.__blendnSocketIo
  const body = await (await health()).json()
  expect(body.pool).toEqual({ total: 4, idle: 1, waiting: 2 })
  expect(body.sockets).toBe(7)
  expect(Object.keys(body.eventLoopDelayMs).sort()).toEqual(["max", "p50", "p99"])
  for (const value of Object.values(body.eventLoopDelayMs)) expect(typeof value).toBe("number")
})

it("says null, not zero, for a pool not built yet or a process without Socket.io", async () => {
  mockPoolStats.mockReturnValue(null)
  const body = await (await health()).json()
  expect(body.pool).toBeNull()
  expect(body.sockets).toBeNull()
})

it("the event-loop delay is the last full minute, and a read never resets it (the endpoint is public)", async () => {
  // Only the minute timer is fake: the histogram, the stall and the waits are real.
  jest.useFakeTimers({
    doNotFake: ["Date", "hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout"],
  })
  try {
    let route: typeof import("@/app/api/health/route") | undefined
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      route = require("@/app/api/health/route")
    })
    const read = async () => (await (await route!.GET()).json()).eventLoopDelayMs

    // Node's histogram skips the first tick after enable/reset; let the loop turn first.
    await new Promise((r) => setTimeout(r, 30))
    const stallUntil = Date.now() + 150
    while (Date.now() < stallUntil) {
      // a 150 ms synchronous block: the event loop cannot turn
    }
    await new Promise((r) => setTimeout(r, 30))
    expect((await read()).max).toBe(0) // the first minute is not over yet

    jest.advanceTimersByTime(60_000)
    const stalled = await read()
    expect(stalled.max).toBeGreaterThanOrEqual(100)
    expect(await read()).toEqual(stalled) // a second caller sees the same minute

    await new Promise((r) => setTimeout(r, 50))
    jest.advanceTimersByTime(60_000)
    expect((await read()).max).toBeLessThan(100)
  } finally {
    jest.useRealTimers()
  }
})

it.each([
  ["nobody signed in", null],
  ["an organizer", { id: "o", role: "organizer" }],
  ["an attendee", { id: "a", role: "attendee" }],
])("matching coverage is a 404 for %s", async (_who, user) => {
  mockCurrentUser.mockResolvedValue(user)
  const res = await matching()
  expect(res.status).toBe(404)
  expect(mockCoverage).not.toHaveBeenCalled()
})

it("an app admin reads matching coverage, uncached", async () => {
  mockCurrentUser.mockResolvedValue({ id: "ad", role: "app_admin" })
  const res = await matching()
  expect(res.status).toBe(200)
  expect(res.headers.get("cache-control")).toBe("no-store")
  expect(await res.json()).toEqual({ status: "ok", attendees: 10, rankable: 9, minInterestsToRank: 3 })
})
