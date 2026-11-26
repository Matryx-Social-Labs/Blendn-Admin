/**
 * Every background loop beats at the end of a pass that worked; a watchdog says
 * once when one has gone quiet for 3 × its interval, and once when it is back
 * (SCRUM-1228). A loop that stops while the process stays up used to be found
 * by users: occupancy climbing for ever, "the event was quiet".
 */
const info = jest.fn()
const logError = jest.fn()
jest.mock("@/lib/logger", () => ({ logger: { info: (...a: unknown[]) => info(...a), warn: jest.fn(), error: (...a: unknown[]) => logError(...a) } }))

import { beat, checkLoops, staleLoops } from "@/lib/heartbeat"

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0)

beforeEach(() => {
  globalThis.__blendnHeartbeats = undefined
  info.mockReset()
  logError.mockReset()
})

it("a loop that beat within 3 × its interval is not stale; past it, it is", () => {
  beat("presence", 5 * MIN, T0)
  expect(staleLoops(T0 + 15 * MIN)).toEqual([])
  expect(staleLoops(T0 + 15 * MIN + 1)).toEqual(["presence"])
})

it("a loop that never registered is never stale (TICKETING off starts nothing)", () => {
  beat("presence", 5 * MIN, T0)
  expect(staleLoops(T0 + 24 * 60 * MIN)).toEqual(["presence"])
  expect(staleLoops(T0 + 24 * 60 * MIN)).not.toContain("ticket-holds")
})

it("a loop silent for 3 × its interval is reported once, then once when it beats again", () => {
  beat("reminders", 5 * MIN, T0)

  checkLoops(T0 + 10 * MIN)
  expect(logError).not.toHaveBeenCalled()

  checkLoops(T0 + 16 * MIN)
  checkLoops(T0 + 17 * MIN)
  checkLoops(T0 + 40 * MIN)
  expect(logError).toHaveBeenCalledTimes(1)
  // The loop in the message: logger.error fingerprints on the message, so each loop is its own Sentry issue.
  expect(logError).toHaveBeenCalledWith("Background loop stalled: reminders", {
    loop: "reminders",
    lastBeatAt: new Date(T0).toISOString(),
    intervalMs: 5 * MIN,
  })

  beat("reminders", 5 * MIN, T0 + 41 * MIN)
  checkLoops(T0 + 42 * MIN)
  checkLoops(T0 + 43 * MIN)
  expect(info).toHaveBeenCalledTimes(1)
  expect(info).toHaveBeenCalledWith("Background loop recovered", { loop: "reminders", stalledSince: new Date(T0).toISOString() })
  expect(staleLoops(T0 + 43 * MIN)).toEqual([])

  // A second stall is a second report.
  checkLoops(T0 + 41 * MIN + 16 * MIN)
  expect(logError).toHaveBeenCalledTimes(2)
})

it("the state lives on globalThis, so the health route's bundle reads what server.ts's loops wrote", () => {
  beat("sentiment", MIN, T0)
  expect(globalThis.__blendnHeartbeats?.loops.get("sentiment")).toEqual({ at: T0, intervalMs: MIN })
})

it("never throws, even when the logger does", () => {
  beat("staff-alert", MIN, T0)
  logError.mockImplementation(() => {
    throw new Error("logger down")
  })
  expect(() => checkLoops(T0 + 10 * MIN)).not.toThrow()
})
