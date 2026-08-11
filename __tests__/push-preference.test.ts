/**
 * `profiles.push_enabled` had never suppressed a single notification.
 *
 * It is stored, returned by `GET /profiles/:userId`, and rendered as a switch
 * in the app's settings — but `lib/push-notifications.ts` selected tokens by
 * `user_id` alone. Every sender ignored it. The switch was decorative.
 *
 * These tests assert the *query*, not the send, because the query is where the
 * rule lives and where a future refactor would quietly drop it.
 */

const findMany = jest.fn()

jest.mock("@/lib/db", () => ({
  db: {
    push_tokens: { findMany: (...args: unknown[]) => findMany(...args) },
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
    async sendPushNotificationsAsync() {
      return []
    }
  },
}))

import { sendBulkPushNotifications, sendPushNotification } from "@/lib/push-notifications"

/** The `where` clause of the first (and only) token query in a call. */
function whereClause(): Record<string, unknown> {
  expect(findMany).toHaveBeenCalled()
  return (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
}

beforeEach(() => {
  findMany.mockReset()
  findMany.mockResolvedValue([])
})

describe("push token selection respects push_enabled", () => {
  it("filters out people who turned notifications off", async () => {
    await sendPushNotification({ userId: "u1", title: "t", body: "b" })

    const where = whereClause()
    expect(where).toMatchObject({
      user_id: "u1",
      NOT: { user: { profile: { is: { push_enabled: false } } } },
    })
  })

  it("applies the same rule to the bulk path", async () => {
    /*
     * Group-message fan-out is the loudest sender in the product. A preference
     * honoured everywhere except here would read as broken.
     */
    await sendBulkPushNotifications({ userIds: ["u1", "u2"], title: "t", body: "b" })

    const where = whereClause()
    expect(where).toMatchObject({
      user_id: { in: ["u1", "u2"] },
      NOT: { user: { profile: { is: { push_enabled: false } } } },
    })
  })

  it("excludes the opt-out rather than including the opt-in", async () => {
    /*
     * The distinction is load-bearing, not stylistic.
     *
     * `User.profile` is optional and `push_enabled` is `@default(true)`. The
     * obvious spelling — `user: { profile: { push_enabled: true } }` — drops
     * every user with no `profiles` row, turning this bug fix into a wider
     * outage than the bug. A negative filter reproduces the column default:
     * a null profile does not match `push_enabled: false`, so it survives.
     *
     * If someone "simplifies" this to a positive filter, this test fails.
     */
    await sendPushNotification({ userId: "u1", title: "t", body: "b" })

    const where = whereClause()
    expect(where).toHaveProperty("NOT")
    expect(JSON.stringify(where)).not.toContain('"push_enabled":true')
  })

  it("still limits to five devices per user", async () => {
    // Pre-existing behaviour that the new filter must not disturb.
    await sendPushNotification({ userId: "u1", title: "t", body: "b" })
    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 5 })
  })

  it("reports failure rather than throwing when nobody is reachable", async () => {
    // Opting out is not an error. A caller that treats it as one would log
    // noise on every notification to every opted-out user.
    await expect(
      sendPushNotification({ userId: "u1", title: "t", body: "b" })
    ).resolves.toBe(false)
  })
})
