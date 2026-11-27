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
const findLiveEvents = jest.fn()
const readLiveSnapshot = jest.fn()
const executeRaw = jest.fn()
jest.mock("@/lib/db", () => ({
  db: { events: { findMany: () => findLiveEvents() }, $executeRaw: (...a: unknown[]) => executeRaw(...a) },
}))
jest.mock("@/lib/live-snapshot", () => ({ readLiveSnapshot: (...a: unknown[]) => readLiveSnapshot(...a) }))
jest.mock("@/lib/live-alert-mail", () => ({ mailLiveAlert: jest.fn() }))
jest.mock("@/lib/deleted-account-records", () => ({ purgeDeletedAccountRecords: async () => 0 }))
jest.mock("@/lib/leads", () => ({ purgeLeadPii: async () => 0 }))
const listPublicObjects = jest.fn()
jest.mock("@/lib/tigris", () => ({
  bucketFor: (folder: string) => `${folder}-bucket`,
  listPublicObjects: (...a: unknown[]) => listPublicObjects(...a),
  deleteFile: jest.fn(),
  extractKeyFromUrl: jest.fn(),
}))

import { reminderPassInFlight, startReminderSweeper, stopReminderSweeper } from "@/lib/reminder-sweeper"
import { startTicketHoldSweeper, stopTicketHoldSweeper } from "@/lib/ticket-hold-sweeper"
import { startTicketReconciler, stopTicketReconciler } from "@/lib/ticket-reconcile"
import { startPayoutReleaser, stopPayoutReleaser } from "@/lib/payout-release"
import { startIssueSweeper, stopIssueSweeper } from "@/lib/event-issues"
import { runSweep as runRetentionSweep } from "@/lib/notification-retention"
import { startOrphanPhotoSweeper, stopOrphanPhotoSweeper } from "@/lib/photo-orphans"

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
  stopTicketReconciler()
  stopPayoutReleaser()
  stopIssueSweeper()
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

it.each([
  ["ticket-holds", startTicketHoldSweeper],
  ["ticket-reconcile", startTicketReconciler],
  ["payout-release", startPayoutReleaser],
])("%s starts nothing and never registers while TICKETING is off", (_name, start) => {
  ticketingOn.mockReturnValue(false)
  start()
  expect(beat).not.toHaveBeenCalled()
})

it("with TICKETING on, the ticket-hold loop registers and beats after its pass (the positive control)", async () => {
  ticketingOn.mockReturnValue(true)
  startTicketHoldSweeper()
  expect(beat).toHaveBeenCalledWith("ticket-holds", 60_000)
  await jest.advanceTimersByTimeAsync(0)
  expect(beat).toHaveBeenCalledTimes(2)
  ticketingOn.mockReturnValue(false)
})

describe("the issues loop", () => {
  const live = [{ id: "e1", start_time: new Date(0) }, { id: "e2", start_time: new Date(0) }]

  it("a pass where every live event failed is a failed pass: an error, and no beat", async () => {
    findLiveEvents.mockResolvedValue(live)
    readLiveSnapshot.mockRejectedValue(new Error("snapshot broken"))
    startIssueSweeper()
    beat.mockClear()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(logError).toHaveBeenCalledWith("Issue sweep failed", { error: "every live event failed (2)" })
    expect(beat).not.toHaveBeenCalled()
  })

  it("one event failing is that event's problem: the pass still beats", async () => {
    findLiveEvents.mockResolvedValue(live)
    readLiveSnapshot.mockRejectedValueOnce(new Error("one bad event")).mockResolvedValueOnce(null)
    startIssueSweeper()
    beat.mockClear()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(beat).toHaveBeenCalledWith("issues", 60_000)
  })

  it("a quiet night with no live events beats", async () => {
    findLiveEvents.mockResolvedValue([])
    startIssueSweeper()
    beat.mockClear()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(beat).toHaveBeenCalledWith("issues", 60_000)
  })
})

describe("the retention loop beats only when both drains did not throw", () => {
  it("a notifications batch that throws: no beat", async () => {
    jest.useRealTimers()
    executeRaw.mockRejectedValueOnce(new Error("statement timeout")).mockResolvedValue(0)
    await runRetentionSweep()
    expect(beat).not.toHaveBeenCalled()
  })

  it("both drained: one beat", async () => {
    jest.useRealTimers()
    executeRaw.mockResolvedValue(0)
    await runRetentionSweep()
    expect(beat).toHaveBeenCalledWith("notification-retention", 6 * 60 * 60 * 1000)
  })
})

describe("the photo-orphans loop beats only when both sweeps came back", () => {
  const HOUR = 60 * 60 * 1000
  const failing = (bucket: string) => async (_prefix: string, _cursor: string | undefined, listed: string) => {
    if (listed === bucket) throw new Error("list refused")
    return { objects: [], next: undefined }
  }
  afterEach(() => stopOrphanPhotoSweeper())

  it.each([
    ["photo", "profile-bucket"],
    ["chat upload", "chat-bucket"],
  ])("the %s sweep failing (null): its error, and no beat", async (label, bucket) => {
    listPublicObjects.mockImplementation(failing(bucket))
    startOrphanPhotoSweeper()
    beat.mockClear()
    await jest.advanceTimersByTimeAsync(0)
    expect(logError).toHaveBeenCalledWith(`Orphan ${label} sweep failed`, { error: "list refused" })
    expect(beat).not.toHaveBeenCalled()
  })

  it("both came back: one beat", async () => {
    listPublicObjects.mockImplementation(failing("none"))
    startOrphanPhotoSweeper()
    beat.mockClear()
    await jest.advanceTimersByTimeAsync(0)
    expect(beat).toHaveBeenCalledTimes(1)
    expect(beat).toHaveBeenCalledWith("photo-orphans", HOUR)
  })
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
    ["lib/sentiment-sweeper.ts", "sentiment", "BEAT_INTERVAL_MS"],
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

  // The pass's beat sits in the pass's `try`, after the work: never in a `catch` or `finally`, where a failing pass would
  // beat too. Retention beats after its drains' own catches, on their result; its behavioural test above covers it.
  it.each(LOOPS.filter(([file]) => file !== "lib/notification-retention.ts"))(
    "%s's pass beat for %s is inside a try, not a catch or finally",
    (file, name, interval) => {
      const src = code(file)
      const inTry = src.split(`beat("${name}", ${interval})`).slice(0, -1).filter((before) => {
        const last = [...before.matchAll(/\btry \{|(?<!\.)\bcatch\b|(?<!\.)\bfinally\b/g)].pop()
        return last?.[0] === "try {"
      })
      expect(inTry).toHaveLength(1)
    }
  )

  it("covers every loop background.ts starts", () => {
    // Every module background.ts imports a start function from is in LOOPS, so a new loop cannot skip the watchdog.
    const bg = code("lib/background.ts")
    const loopModules = [...bg.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([\w-]+)"/g)]
      .filter((m) => /\bstart\w+/.test(m[1]) && m[2] !== "heartbeat")
      .map((m) => `lib/${m[2]}.ts`)
    expect(loopModules).toHaveLength(13)
    expect(new Set(loopModules)).toEqual(new Set(LOOPS.map(([file]) => file).filter((f) => f !== "lib/sponsored-scheduler.ts")))
  })

  it("background.ts runs the watchdog and stops it", () => {
    const bg = code("lib/background.ts")
    expect(bg).toMatch(/^\s*startWatchdog\(\)/m)
    expect(bg).toMatch(/^\s*stopWatchdog\(\)/m)
  })
})
