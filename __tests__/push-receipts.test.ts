/**
 * Expo push receipts, a chunk that throws, and tokens nobody uses (SCRUM-1270).
 *
 * The immediate ticket only says Expo accepted the message. Whether Apple or
 * Google took it arrives later as a receipt, and wrong FCM or APNs credentials
 * (`InvalidCredentials`) show up nowhere else: Android push could be fully
 * broken with nothing in the logs. Expo client mocked; no network.
 */
const sendChunk = jest.fn()
const getReceipts = jest.fn()
const tokens = jest.fn()
const deleteTokens = jest.fn()
const error = jest.fn()
const capture = jest.fn()

jest.mock("@/lib/badge-count", () => ({ badgeCountsFor: async () => new Map() }))
jest.mock("@/lib/db", () => ({
  db: {
    notifications: {
      create: async () => ({ id: "row" }),
      createManyAndReturn: async ({ data }: { data: { user_id: string }[] }) => data.map((d) => ({ id: `row-${d.user_id}`, user_id: d.user_id })),
    },
    push_tokens: { findMany: (...a: unknown[]) => tokens(...a), deleteMany: (...a: unknown[]) => deleteTokens(...a) },
  },
}))
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    // One message per chunk, so a test can fail the first and watch the second.
    chunkPushNotifications(m: unknown[]) {
      return m.map((x) => [x])
    }
    sendPushNotificationsAsync(chunk: unknown[]) {
      return sendChunk(chunk)
    }
    chunkPushNotificationReceiptIds(ids: string[]) {
      return [ids]
    }
    getPushNotificationReceiptsAsync(ids: string[]) {
      return getReceipts(ids)
    }
  },
}))
jest.mock("@sentry/nextjs", () => ({ captureMessage: (...a: unknown[]) => capture(...a) }))
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: (...a: unknown[]) => error(...a), debug: jest.fn() } }))

import {
  checkPushReceipts,
  PUSH_RECEIPT_DELAY_MS,
  PUSH_TOKEN_IDLE_DAYS,
  pruneIdlePushTokens,
  sendBulkPushNotifications,
  sendPushNotification,
} from "@/lib/push-notifications"

const data = { type: "announcement" as const, eventId: "e1" }
const device = (token: string, platform = "android") => ({ user_id: "u1", token, platform, channel_set: null })
const later = () => Date.now() + PUSH_RECEIPT_DELAY_MS + 60_000

let ticket = 0
beforeEach(() => {
  delete (globalThis as { __blendnPushTickets?: unknown }).__blendnPushTickets
  for (const m of [sendChunk, getReceipts, tokens, deleteTokens, error, capture]) m.mockReset()
  sendChunk.mockImplementation(async (chunk: unknown[]) => chunk.map(() => ({ status: "ok", id: `ticket-${++ticket}` })))
  deleteTokens.mockResolvedValue({ count: 1 })
})

describe("receipts", () => {
  it("deletes the token a receipt says is no longer registered, and forgets the ticket", async () => {
    tokens.mockResolvedValue([device("dead")])
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data })
    getReceipts.mockImplementation(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }]))
    )

    await expect(checkPushReceipts(later())).resolves.toEqual({ checked: 1, removed: 1 })
    expect(deleteTokens).toHaveBeenCalledWith({ where: { token: "dead" } })
    expect(capture).not.toHaveBeenCalled()

    await expect(checkPushReceipts(later())).resolves.toEqual({ checked: 0, removed: 0 })
  })

  it("asks nothing for a ticket younger than the receipt delay", async () => {
    tokens.mockResolvedValue([device("fresh")])
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data })

    await expect(checkPushReceipts(Date.now())).resolves.toEqual({ checked: 0, removed: 0 })
    expect(getReceipts).not.toHaveBeenCalled()
  })

  it("reports InvalidCredentials as an error with its code and platform, once per pass, and keeps the token", async () => {
    tokens.mockResolvedValue([
      { ...device("a1"), user_id: "a" },
      { ...device("a2"), user_id: "b" },
      { ...device("i1", "ios"), user_id: "c" },
    ])
    await sendBulkPushNotifications({ userIds: ["a", "b", "c"], title: "t", body: "b", data })
    getReceipts.mockImplementation(async (ids: string[]) =>
      Object.fromEntries(
        ids.map((id, i) => [id, i < 2 ? { status: "error", message: "bad FCM key", details: { error: "InvalidCredentials" } } : { status: "ok" }])
      )
    )

    await checkPushReceipts(later())

    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith("Push receipt errors", { error: "InvalidCredentials", platform: "android", count: 2 })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(
      "Push receipt errors: InvalidCredentials (android)",
      expect.objectContaining({ level: "error", tags: { push_error: "InvalidCredentials", platform: "android" } })
    )
    expect(deleteTokens).not.toHaveBeenCalled()
  })

  it("keeps the tickets of a receipt request that throws, for the next pass", async () => {
    tokens.mockResolvedValue([device("x")])
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data })
    getReceipts.mockRejectedValueOnce(new Error("503"))

    await expect(checkPushReceipts(later())).resolves.toEqual({ checked: 0, removed: 0 })
    expect(error).toHaveBeenCalledWith("Push receipt request failed", expect.objectContaining({ error: "503" }))

    getReceipts.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { status: "ok" }])))
    await expect(checkPushReceipts(later())).resolves.toEqual({ checked: 1, removed: 0 })
  })
})

describe("a chunk that throws", () => {
  it("does not stop the single-user send: the second chunk still goes", async () => {
    tokens.mockResolvedValue([device("first"), device("second")])
    sendChunk.mockRejectedValueOnce(new Error("socket hang up"))

    await expect(sendPushNotification({ userId: "u1", title: "t", body: "b", data })).resolves.toBe(true)
    expect(sendChunk).toHaveBeenCalledTimes(2)
    expect(sendChunk.mock.calls[1][0]).toEqual([expect.objectContaining({ to: "second" })])
  })
})

describe("bulk counts", () => {
  it("counts recipients with no device as noDevice, not failed", async () => {
    tokens.mockResolvedValue([])
    await expect(sendBulkPushNotifications({ userIds: ["a", "b"], title: "t", body: "b", data })).resolves.toEqual({
      sent: 0,
      failed: 0,
      noDevice: 2,
    })
  })

  it("tells the three apart in one send", async () => {
    tokens.mockResolvedValue([
      { ...device("ok"), user_id: "a" },
      { ...device("bad"), user_id: "b" },
    ])
    sendChunk
      .mockResolvedValueOnce([{ status: "ok", id: "t-ok" }])
      .mockResolvedValueOnce([{ status: "error", message: "nope", details: { error: "MessageTooBig" } }])
    await expect(sendBulkPushNotifications({ userIds: ["a", "b", "c"], title: "t", body: "b", data })).resolves.toEqual({
      sent: 1,
      failed: 1,
      noDevice: 1,
    })
  })
})

describe("idle tokens", () => {
  it(`deletes a token not refreshed in ${PUSH_TOKEN_IDLE_DAYS} days and keeps a newer one`, async () => {
    const now = new Date("2026-11-26T12:00:00Z")
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000)
    const rows = [
      { token: "old", updated_at: daysAgo(91) },
      { token: "recent", updated_at: daysAgo(89) },
    ]
    deleteTokens.mockImplementation(async ({ where }: { where: { updated_at: { lt: Date } } }) => {
      const gone = rows.filter((r) => r.updated_at < where.updated_at.lt)
      return { count: gone.length, gone }
    })

    await expect(pruneIdlePushTokens(now)).resolves.toBe(1)
    const { where } = deleteTokens.mock.calls[0][0]
    expect(rows.filter((r) => r.updated_at < where.updated_at.lt).map((r) => r.token)).toEqual(["old"])
  })
})
