/**
 * SCRUM-756: a signal recorded inside the flush window of the last flush has a
 * timer behind it. It used to wait for the NEXT call to `record` (3+ minutes on
 * a quiet staging replica) and was lost if the process died first.
 *
 * A mocked client and fake timers: what is under test is when the write is
 * attempted, not what the database does with it (product-events.itest.ts).
 */
const createMany = jest.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
jest.mock("@/lib/db", () => ({ db: { product_events: { createMany: (args: { data: unknown[] }) => createMany(args) } } }))
const warn = jest.fn()
jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: (...args: unknown[]) => warn(...args), error: jest.fn() },
}))

import { PRODUCT_EVENTS, flushProductEvents, record, resetProductEventCache } from "@/lib/product-events"

const FLUSH_MS = 10_000
const written = () => createMany.mock.calls.flatMap(([args]) => args.data as { name: string }[]).map((r) => r.name)

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date("2026-10-29T12:00:00Z"))
  createMany.mockClear()
  warn.mockClear()
  resetProductEventCache()
})
afterEach(() => {
  resetProductEventCache()
  jest.useRealTimers()
})

it("writes a second signal inside the window when the window ends, with no third call", async () => {
  record({ name: PRODUCT_EVENTS.app_opened, userId: "u1" }) // first of a burst: flushes at once
  await jest.advanceTimersByTimeAsync(0)
  expect(written()).toEqual(["app_opened"])

  await jest.advanceTimersByTimeAsync(1_000)
  record({ name: PRODUCT_EVENTS.searched, userId: "u1" }) // inside the window: buffered
  await jest.advanceTimersByTimeAsync(0)
  expect(written()).toEqual(["app_opened"])

  await jest.advanceTimersByTimeAsync(FLUSH_MS)
  expect(written()).toEqual(["app_opened", "searched"])
})

it("sets one timer for a burst, not one per signal, and writes the burst in one statement", async () => {
  record({ name: PRODUCT_EVENTS.app_opened, userId: "u1" })
  await jest.advanceTimersByTimeAsync(0)
  createMany.mockClear()

  record({ name: PRODUCT_EVENTS.searched, userId: "u1" })
  record({ name: PRODUCT_EVENTS.feed_browsed, userId: "u1" })
  record({ name: PRODUCT_EVENTS.event_viewed, userId: "u1", entityId: "e1" })
  expect(jest.getTimerCount()).toBe(1)

  await jest.advanceTimersByTimeAsync(FLUSH_MS)
  expect(createMany).toHaveBeenCalledTimes(1)
  expect(written()).toEqual(["searched", "feed_browsed", "event_viewed"])
})

it("does not leave a timer behind once the buffer is flushed, or keep the process alive", async () => {
  record({ name: PRODUCT_EVENTS.app_opened, userId: "u1" })
  await jest.advanceTimersByTimeAsync(0)
  record({ name: PRODUCT_EVENTS.searched, userId: "u1" })
  await flushProductEvents() // a shutdown drain
  expect(written()).toEqual(["app_opened", "searched"])
  expect(jest.getTimerCount()).toBe(0)
})

it("arms the timer for a signal that arrives while a flush is still writing", async () => {
  let release: () => void = () => undefined
  createMany.mockImplementationOnce(
    ({ data }) => new Promise((resolve) => (release = () => resolve({ count: data.length })))
  )
  record({ name: PRODUCT_EVENTS.app_opened, userId: "u1" }) // flush starts and hangs
  record({ name: PRODUCT_EVENTS.searched, userId: "u1" })
  release()
  await jest.advanceTimersByTimeAsync(FLUSH_MS)
  expect(written()).toEqual(["app_opened", "searched"])
})

/*
 * SCRUM-1345: a failed flush used to log at debug (never printed in production)
 * and leave the dropped rows' keys in the seen-set, so the next request that
 * day was deduped and the signal was gone for the day.
 */
describe("a failed flush", () => {
  it("records the same person's signal again on their next request that day", async () => {
    createMany.mockRejectedValueOnce(new Error("Can't reach database server"))
    record({ name: PRODUCT_EVENTS.app_opened, userId: "u1" }) // flush starts and fails
    await jest.advanceTimersByTimeAsync(0)
    createMany.mockClear()

    record({ name: PRODUCT_EVENTS.app_opened, userId: "u1" })
    await jest.advanceTimersByTimeAsync(FLUSH_MS)
    expect(written()).toEqual(["app_opened"])
  })

  it("says so at warn, with how many rows it dropped", async () => {
    createMany.mockRejectedValueOnce(new Error("Can't reach database server"))
    record({ name: PRODUCT_EVENTS.app_opened, userId: "u1" })
    record({ name: PRODUCT_EVENTS.searched, userId: "u2" })
    await flushProductEvents()
    expect(warn).toHaveBeenCalledWith(
      "product events not flushed",
      expect.objectContaining({ dropped: 1, error: expect.stringContaining("Can't reach") })
    )
  })
})

describe("a full buffer", () => {
  const MAX_BUFFERED = 5_000
  const fill = (from: number, n: number) => {
    for (let i = from; i < from + n; i++) record({ name: PRODUCT_EVENTS.app_opened, userId: `u${i}` })
  }

  it("warns once per flush window however many signals it drops", async () => {
    record({ name: PRODUCT_EVENTS.app_opened, userId: "first" }) // flushes at once; the window starts
    await jest.advanceTimersByTimeAsync(0)

    fill(0, MAX_BUFFERED + 3) // three dropped in this window
    expect(warn.mock.calls.filter(([m]) => m === "product events buffer full")).toHaveLength(1)

    await jest.advanceTimersByTimeAsync(FLUSH_MS) // the window ends; its flush empties the buffer
    fill(10_000, MAX_BUFFERED + 2) // two more dropped in the next window
    expect(warn.mock.calls.filter(([m]) => m === "product events buffer full")).toHaveLength(2)
  })
})
