/**
 * The path every deploy takes (SCRUM-1228, SCRUM-1404). `server.ts` exited in
 * `httpServer.close`'s callback while the product-events flush and `closeDb`
 * ran fire-and-forget, and it never waited for the reminder pass that had
 * already claimed its rows: a deploy mid-send lost the rest of the batch.
 */
import { drainAndExit, FORCED_EXIT_MS, IN_FLIGHT_CAP_MS } from "@/lib/shutdown"

type Step = { promise: Promise<void>; resolve: () => void }
const step = (): Step => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const order: string[] = []
const exit = jest.fn((code: number) => void order.push(`exit ${code}`))

function steps(over: Partial<{ flush: Step; inFlight: Step; io: Step; db: Step }> = {}) {
  const s = { flush: step(), inFlight: step(), io: step(), db: step(), ...over }
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
})
afterEach(() => jest.useRealTimers())

it("closes the pool only after the flush and the in-flight reminder pass, and exits after the pool and io are closed", async () => {
  const { s, run } = steps()
  void run()

  s.io.resolve()
  s.flush.resolve()
  await jest.advanceTimersByTimeAsync(100)
  expect(order).not.toContain("closeDb") // the reminder pass is still sending
  expect(exit).not.toHaveBeenCalled()

  s.inFlight.resolve()
  await jest.advanceTimersByTimeAsync(0)
  expect(exit).not.toHaveBeenCalled() // the pool is still closing

  s.db.resolve()
  await jest.advanceTimersByTimeAsync(0)
  expect(order).toEqual(["io closed", "flushed", "reminder pass done", "closeDb", "pool closed", "exit 0"])
  expect(exit).toHaveBeenCalledTimes(1)
})

it("a step that rejects still lets the others finish and the process exit 0", async () => {
  const { s, run } = steps({ flush: { promise: Promise.reject(new Error("db gone")), resolve: () => {} } })
  void run()
  s.inFlight.resolve()
  s.io.resolve()
  s.db.resolve()
  await jest.advanceTimersByTimeAsync(0)
  expect(order).toEqual(["reminder pass done", "io closed", "closeDb", "pool closed", "exit 0"])
})

it("stops waiting for a reminder pass after the cap, then closes the pool", async () => {
  const { s, run } = steps()
  void run()
  s.flush.resolve()
  s.io.resolve()
  s.db.resolve()

  await jest.advanceTimersByTimeAsync(IN_FLIGHT_CAP_MS - 1)
  expect(order).not.toContain("closeDb")
  await jest.advanceTimersByTimeAsync(1)
  expect(order).toEqual(["flushed", "io closed", "closeDb", "pool closed", "exit 0"])
  expect(IN_FLIGHT_CAP_MS).toBeLessThan(FORCED_EXIT_MS)
})

it("a drain that hangs still exits, with 1, at the forced timeout", async () => {
  const { s, run } = steps()
  void run()
  s.inFlight.resolve()
  s.io.resolve() // the flush never settles

  await jest.advanceTimersByTimeAsync(FORCED_EXIT_MS - 1)
  expect(exit).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  expect(exit).toHaveBeenCalledWith(1)
  expect(exit).toHaveBeenCalledTimes(1)
})

it("exits once, not again when the forced timer would have fired", async () => {
  const { s, run } = steps()
  void run()
  for (const x of [s.flush, s.inFlight, s.io, s.db]) x.resolve()
  await jest.advanceTimersByTimeAsync(FORCED_EXIT_MS * 2)
  expect(exit).toHaveBeenCalledTimes(1)
  expect(exit).toHaveBeenCalledWith(0)
})
