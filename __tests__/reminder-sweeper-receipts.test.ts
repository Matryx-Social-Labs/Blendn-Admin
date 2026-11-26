/**
 * The reminder loop reads Expo receipts and prunes idle push tokens on every
 * pass (SCRUM-1270): no cron route, nothing to remember to schedule.
 */
const checkPushReceipts = jest.fn()
const pruneIdlePushTokens = jest.fn()
const info = jest.fn()

jest.mock("@/lib/services/event-notifications.service", () => ({ sendEventReminders: async () => 0, sendRatingRequests: async () => 0 }))
jest.mock("@/lib/mobile-auth", () => ({ cleanupExpiredTokens: async () => 0 }))
jest.mock("@/lib/push-notifications", () => ({ checkPushReceipts: () => checkPushReceipts(), pruneIdlePushTokens: () => pruneIdlePushTokens() }))
jest.mock("@/lib/logger", () => ({ logger: { info: (...a: unknown[]) => info(...a), error: jest.fn() } }))

import { startReminderSweeper, stopReminderSweeper } from "@/lib/reminder-sweeper"

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
