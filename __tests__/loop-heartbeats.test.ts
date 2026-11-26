/**
 * Each loop beats when it starts and at the end of a pass that worked, and only
 * then (SCRUM-1228). A pass that throws still reschedules, but does not beat:
 * three intervals of failing passes is a stall, exactly like a dead timer.
 */
import { readFileSync } from "fs"
import { join } from "path"

const beat = jest.fn()
const sendEventReminders = jest.fn()
const logError = jest.fn()
const ticketingOn = jest.fn(() => false)

jest.mock("@/lib/heartbeat", () => ({ beat: (...a: unknown[]) => beat(...a) }))
jest.mock("@/lib/services/event-notifications.service", () => ({
  sendEventReminders: () => sendEventReminders(),
  sendRatingRequests: async () => 0,
}))
jest.mock("@/lib/results-mail", () => ({ sendResultsMails: async () => 0 }))
jest.mock("@/lib/next-night-nudge", () => ({ sendNextNightNudges: async () => 0, sendFirstNightNudges: async () => 0 }))
jest.mock("@/lib/mobile-auth", () => ({ cleanupExpiredTokens: async () => 0 }))
jest.mock("@/lib/free-window-mail", () => ({ sendFreeWindowEndingMail: async () => 0 }))
jest.mock("@/lib/push-notifications", () => ({
  checkPushReceipts: async () => ({ checked: 0 }),
  pruneIdlePushTokens: async () => 0,
  releaseHeldNotifications: async () => ({ released: 0 }),
}))
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: (...a: unknown[]) => logError(...a) } }))
jest.mock("@/lib/env", () => ({ ticketingOn: () => ticketingOn() }))
jest.mock("@/lib/ticket-holds", () => ({ releaseExpiredHolds: async () => ({ released: 0 }) }))

import { reminderPassInFlight, startReminderSweeper, stopReminderSweeper } from "@/lib/reminder-sweeper"
import { startTicketHoldSweeper, stopTicketHoldSweeper } from "@/lib/ticket-hold-sweeper"

const SWEEP_MS = 5 * 60_000

beforeEach(() => {
  jest.useFakeTimers()
  beat.mockReset()
  logError.mockReset()
  sendEventReminders.mockReset()
})
afterEach(() => {
  stopReminderSweeper()
  stopTicketHoldSweeper()
  jest.useRealTimers()
})

it("the reminder loop beats on start and after a pass that worked", async () => {
  sendEventReminders.mockResolvedValue(0)
  startReminderSweeper()
  expect(beat).toHaveBeenCalledTimes(1)
  expect(beat).toHaveBeenLastCalledWith("reminders", SWEEP_MS)

  await jest.advanceTimersByTimeAsync(SWEEP_MS)
  expect(beat).toHaveBeenCalledTimes(2)
  expect(beat).toHaveBeenLastCalledWith("reminders", SWEEP_MS)
})

it("a pass that throws does not beat, and the loop still runs the next pass", async () => {
  sendEventReminders.mockRejectedValue(new Error("db down"))
  startReminderSweeper()
  beat.mockClear()

  await jest.advanceTimersByTimeAsync(SWEEP_MS)
  expect(logError).toHaveBeenCalledWith("Reminder sweep failed", { error: "db down" })
  expect(beat).not.toHaveBeenCalled()

  await jest.advanceTimersByTimeAsync(SWEEP_MS)
  expect(sendEventReminders).toHaveBeenCalledTimes(2)
  expect(beat).not.toHaveBeenCalled()
})

it("reminderPassInFlight waits for the pass that is sending, and is settled when none is", async () => {
  let finish!: (n: number) => void
  sendEventReminders.mockImplementation(() => new Promise<number>((r) => (finish = r)))
  await expect(reminderPassInFlight()).resolves.toBeUndefined()

  startReminderSweeper()
  await jest.advanceTimersByTimeAsync(SWEEP_MS)
  let settled = false
  void reminderPassInFlight().then(() => (settled = true))
  await jest.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)

  finish(3)
  await jest.advanceTimersByTimeAsync(0)
  expect(settled).toBe(true)
})

it("a loop that starts nothing while TICKETING is off never registers", () => {
  ticketingOn.mockReturnValue(false)
  startTicketHoldSweeper()
  expect(beat).not.toHaveBeenCalled()
})

describe("every loop beats (structural)", () => {
  const ROOT = join(__dirname, "..")
  const code = (rel: string) =>
    readFileSync(join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  // Each loop `startBackgroundWork` starts, plus the sponsored scheduler `initSocketServer` starts. Presence runs two.
  const LOOPS: Array<[file: string, name: string, interval: string]> = [
    ["lib/chat-lifecycle.ts", "chat-lifecycle", "SWEEP_INTERVAL_MS"],
    ["lib/notification-retention.ts", "notification-retention", "SWEEP_INTERVAL_MS"],
    ["lib/presence-sweeper.ts", "presence", "SWEEP_INTERVAL_MS"],
    ["lib/presence-sweeper.ts", "go-live-expiry", "EXPIRY_INTERVAL_MS"],
    ["lib/sentiment-sweeper.ts", "sentiment", "SWEEP_INTERVAL_MS"],
    ["lib/event-issues.ts", "issues", "SWEEP_MS"],
    ["lib/reminder-sweeper.ts", "reminders", "SWEEP_MS"],
    ["lib/photo-sweeper.ts", "photo-moderation", "SWEEP_INTERVAL_MS"],
    ["lib/photo-orphans.ts", "photo-orphans", "ORPHAN_SWEEP_INTERVAL_MS"],
    ["lib/moderation-recheck.ts", "moderation-recheck", "RECHECK_INTERVAL_MS"],
    ["lib/staff-alert.ts", "staff-alert", "STAFF_ALERT_INTERVAL_MS"],
    ["lib/ticket-hold-sweeper.ts", "ticket-holds", "TICKET_HOLD_SWEEP_MS"],
    ["lib/ticket-reconcile.ts", "ticket-reconcile", "TICKET_RECONCILE_MS"],
    ["lib/payout-release.ts", "payout-release", "PAYOUT_RELEASE_MS"],
    ["lib/sponsored-scheduler.ts", "sponsored", "SWEEP_INTERVAL_MS"],
  ]

  it.each(LOOPS)("%s beats as %s on start and after a pass, with its own interval", (file, name, interval) => {
    const calls = code(file).split(`beat("${name}", ${interval})`).length - 1
    expect(calls).toBe(2)
  })

  it("covers every loop background.ts starts", () => {
    // Every module background.ts imports a start function from is in LOOPS, so a new loop cannot skip the watchdog.
    const bg = code("lib/background.ts")
    const loopModules = [...bg.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([\w-]+)"/g)]
      .filter((m) => /\bstart\w+/.test(m[1]))
      .map((m) => `lib/${m[2]}.ts`)
    expect(loopModules).toHaveLength(13)
    expect(new Set(loopModules)).toEqual(new Set(LOOPS.map(([file]) => file).filter((f) => f !== "lib/sponsored-scheduler.ts")))
  })

  it("background.ts runs the watchdog and stops it", () => {
    const bg = code("lib/background.ts")
    expect(bg).toMatch(/checkLoops\(/)
    expect(bg).toMatch(/clearTimeout\(watchdog\)/)
  })
})
