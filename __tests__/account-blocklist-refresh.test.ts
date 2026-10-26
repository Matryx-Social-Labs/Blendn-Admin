/**
 * Refreshing the blocked-accounts set (lib/account-blocklist.ts).
 *
 * Every 30 s one request waited for a full `User` query before it could be
 * answered, on every mobile route. The set is served while it refreshes in the
 * background instead, with two limits that matter because this is a security
 * list: the FIRST load is awaited, and so is any load after the set has gone
 * quiet for too long to be trusted stale. A failed refresh keeps the previous
 * set; it never empties it.
 */
export {} // a module, so its names stay out of the global scope the sibling test also uses

const mockFindMany = jest.fn()
jest.mock("@/lib/db", () => ({ db: { user: { findMany: (...args: unknown[]) => mockFindMany(...args) } } }))
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), error: jest.fn() } }))

type Blocklist = typeof import("@/lib/account-blocklist")

function freshCopy(): Blocklist {
  let copy!: Blocklist
  jest.isolateModules(() => {
    copy = jest.requireActual("@/lib/account-blocklist")
  })
  return copy
}

const shared = globalThis as typeof globalThis & { __blendnBlocklist?: unknown }
const NOW = new Date("2026-10-18T12:00:00.000Z")
const blockedRow = (id: string) => ({ id, deletedAt: null, suspended_at: new Date(NOW.getTime() - 1000), mobile_sessions_revoked_at: null })
const issued = () => Math.floor(NOW.getTime() / 1000) - 5

/** A database read the test settles by hand. */
function slowRead() {
  let answer!: (rows: unknown[]) => void
  let fail!: (e: Error) => void
  mockFindMany.mockImplementationOnce(() => new Promise((resolve, reject) => ((answer = resolve), (fail = reject))))
  return { answer: (rows: unknown[]) => answer(rows), fail: (e: Error) => fail(e) }
}
const settle = () => new Promise((r) => setImmediate(r))

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["setImmediate", "nextTick"] })
  delete shared.__blendnBlocklist
  mockFindMany.mockReset().mockResolvedValue([])
})
afterEach(() => jest.useRealTimers())

describe("recentlyBlocked refresh", () => {
  it("awaits the first load", async () => {
    mockFindMany.mockResolvedValue([blockedRow("u1")])
    const { recentlyBlocked } = freshCopy()
    expect(await recentlyBlocked("u1", issued())).toBe(true)
  })

  it("does not read the database again within 30 s", async () => {
    const { recentlyBlocked } = freshCopy()
    await recentlyBlocked("u1", issued())
    jest.advanceTimersByTime(29_000)
    await recentlyBlocked("u1", issued())
    expect(mockFindMany).toHaveBeenCalledTimes(1)
  })

  it("past 30 s answers from the old set at once and refreshes in the background", async () => {
    mockFindMany.mockResolvedValueOnce([blockedRow("old")])
    const { recentlyBlocked } = freshCopy()
    await recentlyBlocked("old", issued())

    jest.advanceTimersByTime(31_000)
    const refresh = slowRead()
    // Not waiting for the database: the old set still refuses `old`, and `late` is not yet known.
    expect(await recentlyBlocked("old", issued())).toBe(true)
    expect(await recentlyBlocked("late", issued())).toBe(false)
    expect(mockFindMany).toHaveBeenCalledTimes(2)

    refresh.answer([blockedRow("late")])
    await settle()
    expect(await recentlyBlocked("late", issued())).toBe(true)
    expect(mockFindMany).toHaveBeenCalledTimes(2)
  })

  it("starts one refresh however many requests arrive while it runs", async () => {
    const { recentlyBlocked } = freshCopy()
    await recentlyBlocked("u1", issued())
    jest.advanceTimersByTime(31_000)
    slowRead()
    await Promise.all([recentlyBlocked("a", issued()), recentlyBlocked("b", issued()), recentlyBlocked("c", issued())])
    expect(mockFindMany).toHaveBeenCalledTimes(2)
  })

  it("waits for the refresh once the set is too old to serve", async () => {
    mockFindMany.mockResolvedValueOnce([])
    const { recentlyBlocked } = freshCopy()
    await recentlyBlocked("u1", issued())

    jest.advanceTimersByTime(5 * 60_000)
    mockFindMany.mockResolvedValueOnce([blockedRow("u1")])
    // A request after a quiet five minutes must see what changed in them.
    expect(await recentlyBlocked("u1", issued())).toBe(true)
  })

  it("keeps the previous set when a background refresh fails, and never serves an empty one", async () => {
    mockFindMany.mockResolvedValueOnce([blockedRow("u1")])
    const { recentlyBlocked } = freshCopy()
    expect(await recentlyBlocked("u1", issued())).toBe(true)

    jest.advanceTimersByTime(31_000)
    const refresh = slowRead()
    expect(await recentlyBlocked("u1", issued())).toBe(true)
    refresh.fail(new Error("db down"))
    await settle()
    expect(await recentlyBlocked("u1", issued())).toBe(true)
  })

  it("a failed first load is not marked fresh: the next request awaits a retry, not 60 s of an empty set", async () => {
    mockFindMany.mockRejectedValueOnce(new Error("db down"))
    const { recentlyBlocked } = freshCopy()
    // Nothing is known yet, so this one has nothing to refuse with.
    expect(await recentlyBlocked("u1", issued())).toBe(false)

    mockFindMany.mockResolvedValueOnce([blockedRow("u1")])
    jest.advanceTimersByTime(1_000)
    expect(await recentlyBlocked("u1", issued())).toBe(true)
    expect(mockFindMany).toHaveBeenCalledTimes(2)
  })

  it("keeps retrying, awaited each time, while nothing has ever loaded", async () => {
    mockFindMany.mockRejectedValueOnce(new Error("down 1")).mockRejectedValueOnce(new Error("down 2"))
    const { recentlyBlocked } = freshCopy()
    expect(await recentlyBlocked("u1", issued())).toBe(false)
    expect(await recentlyBlocked("u1", issued())).toBe(false)

    mockFindMany.mockResolvedValueOnce([blockedRow("u1")])
    expect(await recentlyBlocked("u1", issued())).toBe(true)
    expect(mockFindMany).toHaveBeenCalledTimes(3)
  })

  it("serves the old set up to 60 s and waits for the refresh past it", async () => {
    // Whether a request, `ms` after the set was loaded, is answered while the refresh read is still pending.
    const answeredWhileReadPends = async (ms: number) => {
      mockFindMany.mockReset().mockResolvedValueOnce([])
      delete shared.__blendnBlocklist
      const { recentlyBlocked } = freshCopy()
      await recentlyBlocked("u1", issued())
      jest.advanceTimersByTime(ms)
      const refresh = slowRead()
      let answered = false
      const asking = recentlyBlocked("u1", issued()).then((v) => ((answered = true), v))
      await settle()
      const whilePending = answered
      refresh.answer([])
      await asking
      return whilePending
    }
    expect(await answeredWhileReadPends(59_000)).toBe(true)
    expect(await answeredWhileReadPends(61_000)).toBe(false)
  })
})
