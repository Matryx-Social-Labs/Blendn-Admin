/**
 * The path every deploy takes (SCRUM-1228, SCRUM-1404). `server.ts` exited in
 * `httpServer.close`'s callback while the product-events flush and `closeDb`
 * ran fire-and-forget, and it never waited for the reminder pass that had
 * already claimed its rows: a deploy mid-send lost the rest of the batch.
 */
import { readFileSync } from "fs"
import { join } from "path"

const logError = jest.fn()
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: (...a: unknown[]) => logError(...a) } }))

import { drainAndExit, FORCED_EXIT_MS, IN_FLIGHT_CAP_MS } from "@/lib/shutdown"

type Step = { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void }
const step = (): Step => {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

const order: string[] = []
const exit = jest.fn((code: number) => void order.push(`exit ${code}`))

function steps() {
  const s = { flush: step(), inFlight: step(), io: step(), db: step() }
  return {
    s,
    run: () =>
      drainAndExit({
        flush: () => s.flush.promise.then(() => void order.push("flushed")),
        inFlight: () => s.inFlight.promise.then(() => void order.push("reminder pass done")),
        closeDb: () => {
          order.push("closeDb")
          return s.db.promise.then(() => void order.push("pool closed"))
        },
        closeIo: () => s.io.promise.then(() => void order.push("io closed")),
        exit,
      }),
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  order.length = 0
  exit.mockClear()
  logError.mockReset()
})
afterEach(() => jest.useRealTimers())

it("closes the pool only after the flush, the in-flight reminder pass and io, and exits after the pool is closed", async () => {
  const { s, run } = steps()
  void run()

  s.flush.resolve()
  s.io.resolve()
  await jest.advanceTimersByTimeAsync(100)
  expect(order).not.toContain("closeDb") // the reminder pass is still sending
  expect(exit).not.toHaveBeenCalled()

  s.inFlight.resolve()
  await jest.advanceTimersByTimeAsync(0)
  expect(order).toContain("closeDb")
  expect(exit).not.toHaveBeenCalled() // the pool is still closing

  s.db.resolve()
  await jest.advanceTimersByTimeAsync(0)
  expect(new Set(order.slice(0, 3))).toEqual(new Set(["flushed", "io closed", "reminder pass done"]))
  expect(order.slice(3)).toEqual(["closeDb", "pool closed", "exit 0"])
  expect(exit).toHaveBeenCalledTimes(1)
  expect(logError).not.toHaveBeenCalled()
})

it("waits for io (the HTTP server's last requests) before closing the pool", async () => {
  const { s, run } = steps()
  void run()
  s.flush.resolve()
  s.inFlight.resolve()
  s.db.resolve()
  await jest.advanceTimersByTimeAsync(100)
  expect(order).not.toContain("closeDb")

  s.io.resolve()
  await jest.advanceTimersByTimeAsync(0)
  expect(order.slice(-3)).toEqual(["closeDb", "pool closed", "exit 0"])
})

it("a step that rejects is logged, and the others still finish and the process exits 0", async () => {
  const { s, run } = steps()
  void run()
  s.flush.reject(new Error("db gone"))
  s.inFlight.resolve()
  s.io.resolve()
  s.db.resolve()
  await jest.advanceTimersByTimeAsync(0)
  expect(order.slice(-3)).toEqual(["closeDb", "pool closed", "exit 0"])
  expect(logError).toHaveBeenCalledWith("Shutdown step failed", { step: "flush", error: "db gone" })
})

it("stops waiting for a reminder pass after the cap, says so, then closes the pool", async () => {
  const { s, run } = steps()
  void run()
  s.flush.resolve()
  s.io.resolve()
  s.db.resolve()

  await jest.advanceTimersByTimeAsync(IN_FLIGHT_CAP_MS - 1)
  expect(order).not.toContain("closeDb")
  expect(logError).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  expect(order.slice(-3)).toEqual(["closeDb", "pool closed", "exit 0"])
  expect(logError).toHaveBeenCalledWith("Shutdown stopped waiting for the reminder pass", { afterMs: IN_FLIGHT_CAP_MS })
  expect(IN_FLIGHT_CAP_MS).toBeLessThan(FORCED_EXIT_MS)
})

it("a drain that hangs still exits, with 1, at the forced timeout, and says so", async () => {
  const { s, run } = steps()
  void run()
  s.inFlight.resolve()
  s.io.resolve() // the flush never settles

  await jest.advanceTimersByTimeAsync(FORCED_EXIT_MS - 1)
  expect(exit).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  expect(exit).toHaveBeenCalledWith(1)
  expect(exit).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledWith("Forced shutdown after timeout", { afterMs: FORCED_EXIT_MS })
})

it("exits once, not again when the forced timer would have fired", async () => {
  const { s, run } = steps()
  void run()
  for (const x of [s.flush, s.inFlight, s.io, s.db]) x.resolve()
  await jest.advanceTimersByTimeAsync(FORCED_EXIT_MS * 2)
  expect(exit).toHaveBeenCalledTimes(1)
  expect(exit).toHaveBeenCalledWith(0)
})

describe("server.ts takes this path (structural)", () => {
  const server = readFileSync(join(__dirname, "..", "server.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

  it("drains through drainAndExit, waiting on the reminder pass, once per process", () => {
    expect(server).toMatch(/void drainAndExit\(\{/)
    expect(server).toMatch(/inFlight: \(\) => reminderPassInFlight\(\)/)
    expect(server).toMatch(/closeIo: \(\) => io\.close\(\)/)
    expect(server).toMatch(/if \(shuttingDown\) return\s+shuttingDown = true/)
  })

  it("no longer exits from httpServer.close's callback (io.close() closes the HTTP server)", () => {
    expect(server).not.toMatch(/httpServer\.close\(/)
    expect(server).not.toMatch(/void flushProductEvents\(\)/)
  })

  it("stops the loops before the drain", () => {
    expect(server.indexOf("stopBackgroundWork()")).toBeGreaterThan(-1)
    expect(server.indexOf("stopBackgroundWork()")).toBeLessThan(server.indexOf("drainAndExit("))
  })
})
