/**
 * The reminder loop reads Expo receipts and prunes idle push tokens on every
 * pass (SCRUM-1270): no cron route, nothing to remember to schedule.
 */
const checkPushReceipts = jest.fn()
const pruneIdlePushTokens = jest.fn()
const info = jest.fn()
const logError = jest.fn()
const sendRatingRequests = jest.fn()
const releaseHeldNotifications = jest.fn()

jest.mock("@/lib/services/event-notifications.service", () => ({ sendEventReminders: async () => 0, sendRatingRequests: () => sendRatingRequests() }))
jest.mock("@/lib/mobile-auth", () => ({ cleanupExpiredTokens: async () => 0 }))
jest.mock("@/lib/push-notifications", () => ({ checkPushReceipts: () => checkPushReceipts(), pruneIdlePushTokens: () => pruneIdlePushTokens(), releaseHeldNotifications: () => releaseHeldNotifications() }))
jest.mock("@/lib/logger", () => ({ logger: { info: (...a: unknown[]) => info(...a), error: (...a: unknown[]) => logError(...a) } }))

import { startReminderSweeper, stopReminderSweeper } from "@/lib/reminder-sweeper"

beforeEach(() => {
  for (const m of [checkPushReceipts, pruneIdlePushTokens, info, logError, sendRatingRequests, releaseHeldNotifications]) m.mockReset()
  sendRatingRequests.mockResolvedValue(0)
  releaseHeldNotifications.mockResolvedValue({ released: 0, pushed: 0 })
})

afterEach(() => {
  stopReminderSweeper()
  jest.useRealTimers()
})

it("reads receipts and prunes idle tokens on a pass, and says so", async () => {
  jest.useFakeTimers()
  checkPushReceipts.mockResolvedValue({ checked: 3, removed: 1 })
  pruneIdlePushTokens.mockResolvedValue(2)

  startReminderSweeper()
  await jest.advanceTimersByTimeAsync(5 * 60_000)

  expect(checkPushReceipts).toHaveBeenCalledTimes(1)
  expect(pruneIdlePushTokens).toHaveBeenCalledTimes(1)
  expect(info).toHaveBeenCalledWith("Push receipts read", { checked: 3, removed: 1 })
  expect(info).toHaveBeenCalledWith("Idle push tokens pruned", { idle: 2 })
})

it("still reads receipts and prunes when a reminder step throws", async () => {
  jest.useFakeTimers()
  sendRatingRequests.mockRejectedValue(new Error("db down"))
  checkPushReceipts.mockResolvedValue({ checked: 0, removed: 0, expired: 0, pending: 0 })
  pruneIdlePushTokens.mockResolvedValue(0)

  startReminderSweeper()
  await jest.advanceTimersByTimeAsync(5 * 60_000)

  expect(checkPushReceipts).toHaveBeenCalledTimes(1)
  expect(pruneIdlePushTokens).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledWith("Reminder sweep failed", { error: "db down" })
})

it("still prunes when the receipt read throws, and says which step failed", async () => {
  jest.useFakeTimers()
  checkPushReceipts.mockRejectedValue(new Error("expo down"))
  pruneIdlePushTokens.mockResolvedValue(0)

  startReminderSweeper()
  await jest.advanceTimersByTimeAsync(5 * 60_000)

  expect(pruneIdlePushTokens).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledWith("Push upkeep failed", { step: "receipts", error: "expo down" })
})

it("releases the night's held pushes on a pass, and says so (SCRUM-1276)", async () => {
  jest.useFakeTimers()
  checkPushReceipts.mockResolvedValue({ checked: 0 })
  pruneIdlePushTokens.mockResolvedValue(0)
  releaseHeldNotifications.mockResolvedValue({ released: 3, pushed: 1 })

  startReminderSweeper()
  await jest.advanceTimersByTimeAsync(5 * 60_000)

  expect(releaseHeldNotifications).toHaveBeenCalledTimes(1)
  expect(info).toHaveBeenCalledWith("Held pushes released", { released: 3, pushed: 1 })
})

it("a release that throws stops neither the receipts nor the reminders, and says which step failed", async () => {
  jest.useFakeTimers()
  releaseHeldNotifications.mockRejectedValue(new Error("db busy"))
  checkPushReceipts.mockResolvedValue({ checked: 0 })
  pruneIdlePushTokens.mockResolvedValue(0)

  startReminderSweeper()
  await jest.advanceTimersByTimeAsync(5 * 60_000)

  expect(checkPushReceipts).toHaveBeenCalledTimes(1)
  expect(sendRatingRequests).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledWith("Push upkeep failed", { step: "quiet-hours release", error: "db busy" })
})
