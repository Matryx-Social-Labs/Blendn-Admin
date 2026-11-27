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
    static isExpoPushToken(t: string) {
      return !t.startsWith("malformed")
    }
    // One message per chunk, so a test can fail the first and watch the second.
    chunkPushNotifications(m: unknown[]) {
      return m.map((x) => [x])
    }
    sendPushNotificationsAsync(chunk: unknown[]) {
      return sendChunk(chunk)
    }
    chunkPushNotificationReceiptIds(ids: string[]) {
      return ids.length > 0 ? [ids] : [] // as the SDK: no ids, no chunk
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

const pass = (checked: number, removed: number, pending = 0) => ({ checked, removed, expired: 0, pending })

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

    await expect(checkPushReceipts(later())).resolves.toEqual(pass(1, 1))
    // Only a row not registered again since the send: a late receipt must not delete a live token.
    expect(deleteTokens).toHaveBeenCalledWith({ where: { token: "dead", updated_at: { lte: expect.any(Date) } } })
    expect(capture).not.toHaveBeenCalled()

    await expect(checkPushReceipts(later())).resolves.toEqual(pass(0, 0))
  })

  it("keeps a ticket whose receipt is not ready yet, and reads it on a later pass", async () => {
    tokens.mockResolvedValue([
      { ...device("a1"), user_id: "a" },
      { ...device("b1"), user_id: "b" },
    ])
    await sendBulkPushNotifications({ userIds: ["a", "b"], title: "t", body: "b", data })
    getReceipts.mockImplementationOnce(async (ids: string[]) => ({ [ids[0]]: { status: "ok" } }))

    await expect(checkPushReceipts(later())).resolves.toEqual(pass(1, 0, 1))
    getReceipts.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { status: "ok" }])))
    await expect(checkPushReceipts(later())).resolves.toEqual(pass(1, 0, 0))
  })

  it("drops a ticket unanswered after a day, and counts it", async () => {
    tokens.mockResolvedValue([device("old")])
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data })
    await expect(checkPushReceipts(Date.now() + 25 * 60 * 60_000)).resolves.toEqual({ checked: 0, removed: 0, expired: 1, pending: 0 })
    expect(getReceipts).not.toHaveBeenCalled()
  })

  it("never deletes with an empty filter when Expo answers with more tickets than messages", async () => {
    tokens.mockResolvedValue([device("only")])
    sendChunk.mockResolvedValueOnce([
      { status: "ok", id: "t-only" },
      { status: "ok", id: "t-extra" },
    ])
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data })
    getReceipts.mockImplementation(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }]))
    )

    await checkPushReceipts(later())
    expect(deleteTokens).toHaveBeenCalledTimes(1)
    expect(deleteTokens.mock.calls[0][0].where.token).toBe("only")
  })

  it("asks nothing for a ticket younger than the receipt delay", async () => {
    tokens.mockResolvedValue([device("fresh")])
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data })

    await expect(checkPushReceipts(Date.now() + PUSH_RECEIPT_DELAY_MS - 1)).resolves.toEqual(pass(0, 0, 1))
    expect(getReceipts).not.toHaveBeenCalled()
  })

  it("reports InvalidCredentials once per platform per pass, with its code, and keeps the tokens", async () => {
    tokens.mockResolvedValue([
      { ...device("a1"), user_id: "a" },
      { ...device("a2"), user_id: "b" },
      { ...device("i1", "ios"), user_id: "c" },
      { ...device("i2", "ios"), user_id: "d" },
    ])
    await sendBulkPushNotifications({ userIds: ["a", "b", "c", "d"], title: "t", body: "b", data })
    const bad = { status: "error", message: "bad key", details: { error: "InvalidCredentials" } }
    getReceipts.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map((id, i) => [id, i < 3 ? bad : { status: "ok" }])))

    await checkPushReceipts(later())

    // One path to Sentry: logger.error reports (SCRUM-1397), split by code and platform through its message and tags.
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(
      "Push receipt errors: InvalidCredentials (android)",
      { error: "InvalidCredentials", platform: "android", count: 2, message: "bad key" },
      { push_error: "InvalidCredentials", platform: "android" }
    )
    expect(error).toHaveBeenCalledWith(
      "Push receipt errors: InvalidCredentials (ios)",
      { error: "InvalidCredentials", platform: "ios", count: 1, message: "bad key" },
      { push_error: "InvalidCredentials", platform: "ios" }
    )
    expect(capture).not.toHaveBeenCalled()
    expect(deleteTokens).not.toHaveBeenCalled()
  })

  it("keeps the tickets of a receipt request that throws, for the next pass", async () => {
    tokens.mockResolvedValue([device("x")])
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data })
    getReceipts.mockRejectedValueOnce(new Error("503"))

    await expect(checkPushReceipts(later())).resolves.toEqual(pass(0, 0, 1))
    expect(error).toHaveBeenCalledWith("Push receipt request failed", expect.objectContaining({ error: "503" }))
    expect(capture).not.toHaveBeenCalled()

    getReceipts.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { status: "ok" }])))
    await expect(checkPushReceipts(later())).resolves.toEqual(pass(1, 0))
  })
})

describe("a chunk that throws", () => {
  it("does not stop the single-user send: the second chunk still goes", async () => {
    tokens.mockResolvedValue([device("first"), device("second")])
    sendChunk.mockRejectedValueOnce(new Error("socket hang up"))

    await expect(sendPushNotification({ userId: "u1", title: "t", body: "b", data })).resolves.toBe(true)
    expect(sendChunk).toHaveBeenCalledTimes(2)
    expect(sendChunk.mock.calls[1][0]).toEqual([expect.objectContaining({ to: "second" })])
    expect(error).toHaveBeenCalledWith("Failed to send push notification chunk", { error: "socket hang up" })
  })

  it("counts a thrown bulk chunk as failed and sends the rest", async () => {
    tokens.mockResolvedValue([
      { ...device("x"), user_id: "a" },
      { ...device("y"), user_id: "b" },
    ])
    sendChunk.mockRejectedValueOnce(new Error("502"))
    await expect(sendBulkPushNotifications({ userIds: ["a", "b"], title: "t", body: "b", data })).resolves.toEqual({ sent: 1, failed: 1, noDevice: 0 })
  })

  it("deletes the token of a refused ticket in a later chunk, and only that one", async () => {
    tokens.mockResolvedValue([
      { ...device("live"), user_id: "a" },
      { ...device("dead"), user_id: "b" },
    ])
    sendChunk
      .mockResolvedValueOnce([{ status: "ok", id: "t-live" }])
      .mockResolvedValueOnce([{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }])
    await sendBulkPushNotifications({ userIds: ["a", "b"], title: "t", body: "b", data })
    expect(deleteTokens).toHaveBeenCalledTimes(1)
    expect(deleteTokens).toHaveBeenCalledWith({ where: { token: "dead" } })
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

  it("counts a person whose only token is malformed as noDevice, and each person once", async () => {
    tokens.mockResolvedValue([{ ...device("malformed-1"), user_id: "a" }])
    await expect(sendBulkPushNotifications({ userIds: ["a", "a", "b"], title: "t", body: "b", data })).resolves.toEqual({
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
    expect(deleteTokens).toHaveBeenCalledWith({ where: { updated_at: { lt: daysAgo(90) } } })
    expect(PUSH_TOKEN_IDLE_DAYS).toBe(90)
  })
})
