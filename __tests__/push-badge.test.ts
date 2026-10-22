/**
 * A push sets the app icon's number (SCRUM-740): the app is closed, so nothing
 * else will. A count that fails is a push without one, never a push not sent,
 * and a caller's own `badge` wins.
 */
const countBadges = jest.fn()
const tokens = jest.fn()
const sent: Array<{ to: string; badge?: number }> = []

jest.mock("@/lib/badge-count", () => ({ badgeCountsFor: (...a: unknown[]) => countBadges(...a) }))
jest.mock("@/lib/db", () => ({
  db: {
    notifications: {
      create: async () => ({ id: "row" }),
      createManyAndReturn: async ({ data }: { data: { user_id: string }[] }) => data.map((d) => ({ id: `row-${d.user_id}`, user_id: d.user_id })),
    },
    push_tokens: { findMany: (...a: unknown[]) => tokens(...a) },
  },
}))
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Array<{ to: string; badge?: number }>) {
      sent.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  },
}))
const warn = jest.fn()
jest.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import { sendBulkPushNotifications, sendPushNotification } from "@/lib/push-notifications"

const data = { type: "announcement" as const, eventId: "e1" }

beforeEach(() => {
  sent.length = 0
  countBadges.mockReset()
  warn.mockReset()
  tokens.mockReset().mockResolvedValue([{ user_id: "u1", token: "t1", channel_set: null }])
})

describe("single push", () => {
  it("carries the person's own count", async () => {
    countBadges.mockResolvedValue(new Map([["u1", 4]]))
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data })
    expect(countBadges).toHaveBeenCalledWith(["u1"])
    expect(sent).toEqual([expect.objectContaining({ to: "t1", badge: 4 })])
  })

  it("keeps a badge the caller set, and counts nothing", async () => {
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data, badge: 9 })
    expect(countBadges).not.toHaveBeenCalled()
    expect(sent[0].badge).toBe(9)
  })

  it("is sent without a badge when the count fails, and says so", async () => {
    countBadges.mockRejectedValue(new Error("pool busy"))
    await expect(sendPushNotification({ userId: "u1", title: "t", body: "b", data })).resolves.toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].badge).toBeUndefined()
    expect(warn).toHaveBeenCalledWith("Could not count the badge for a push", expect.anything())
  })

  it("counts nobody for a person with no device", async () => {
    tokens.mockResolvedValue([])
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data })
    expect(countBadges).not.toHaveBeenCalled()
  })
})

describe("bulk push", () => {
  const devices = (ids: string[]) => ids.map((id) => ({ user_id: id, token: `tok-${id}`, channel_set: null }))

  it("counts every recipient with a device in ONE call, and each message carries its own person's number", async () => {
    tokens.mockResolvedValue(devices(["a", "b", "c"]))
    countBadges.mockResolvedValue(new Map([["a", 1], ["b", 0], ["c", 12]]))
    await sendBulkPushNotifications({ userIds: ["a", "b", "c", "no-device"], title: "t", body: "b", data })
    expect(countBadges).toHaveBeenCalledTimes(1)
    expect(countBadges).toHaveBeenCalledWith(["a", "b", "c"])
    expect(Object.fromEntries(sent.map((m) => [m.to, m.badge]))).toEqual({ "tok-a": 1, "tok-b": 0, "tok-c": 12 })
  })

  it("is sent without badges when the count fails", async () => {
    tokens.mockResolvedValue(devices(["a"]))
    countBadges.mockRejectedValue(new Error("pool busy"))
    await expect(sendBulkPushNotifications({ userIds: ["a"], title: "t", body: "b", data })).resolves.toEqual({ sent: 1, failed: 0 })
    expect(sent[0].badge).toBeUndefined()
  })

  it("keeps a badge the caller set for everybody, and counts nothing", async () => {
    tokens.mockResolvedValue(devices(["a", "b"]))
    await sendBulkPushNotifications({ userIds: ["a", "b"], title: "t", body: "b", data, badge: 3 })
    expect(countBadges).not.toHaveBeenCalled()
    expect(sent.map((m) => m.badge)).toEqual([3, 3])
  })
})
