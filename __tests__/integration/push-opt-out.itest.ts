/**
 * `push_enabled` decides whether a push goes out — evaluated by Postgres,
 * through the real sender.
 *
 * The unit test pins the SHAPE of the filter. Its own docstring says why the
 * shape matters: an inclusive filter (`push_enabled: true`) would drop
 * everyone with no `profiles` row, because `User.profile` is optional. That
 * is a claim about how Postgres evaluates a relation filter, so only Postgres
 * can confirm it — and only through `sendPushNotification`, because the
 * selector is private and a test that writes its own filter proves nothing
 * about the module (the first version of this file did exactly that, and a
 * control that inverted the module's filter passed it).
 *
 * Expo's client is mocked: with a synthetic token the real one answers
 * DeviceNotRegistered and the sender deletes the row — the stale-token
 * cleanup working, which would read here as the switch failing.
 */
type Ticket = { status: string; id?: string; message?: string; details?: { error: string } }
const sent = jest.fn(async (msgs: { to: string }[]): Promise<Ticket[]> => msgs.map(() => ({ status: "ok", id: "t" })))
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(t: string) {
      return t.startsWith("ExponentPushToken[")
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    sendPushNotificationsAsync(chunk: { to: string }[]) {
      return sent(chunk)
    }
  }
  return { Expo }
})

import { sendPushNotification } from "@/lib/push-notifications"
import { closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []

afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

beforeEach(() => sent.mockClear())

async function person(label: string, profile: { push_enabled: boolean } | null) {
  const id = await makeUser(testId(label))
  users.push(id)
  if (profile) await db.profiles.create({ data: { id, ...profile } })
  await db.push_tokens.create({
    data: { user_id: id, token: `ExponentPushToken[itest-${id}]`, platform: "ios" },
  })
  return id
}

const push = (userId: string) =>
  sendPushNotification({ userId, title: "t", body: "b", data: { type: "event_update" } })

describe("the switch is honoured on the send path", () => {
  it("opted out: nothing is sent, and the token is left alone for when it is turned back on", async () => {
    const id = await person("po-off", { push_enabled: false })
    await expect(push(id)).resolves.toBe(false)
    expect(sent).not.toHaveBeenCalled()
    await expect(db.push_tokens.count({ where: { user_id: id } })).resolves.toBe(1)
  })

  it("opted in: the push goes to that token", async () => {
    const id = await person("po-on", { push_enabled: true })
    await expect(push(id)).resolves.toBe(true)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][0].map((m) => m.to)).toEqual([`ExponentPushToken[itest-${id}]`])
  })

  it("no profile row at all: still reachable — the column's default is true", async () => {
    const id = await person("po-none", null)
    await expect(push(id)).resolves.toBe(true)
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it("a DeviceNotRegistered ticket deletes that token row and no other", async () => {
    // The cleanup the docstring above says the real client would trigger,
    // driven deliberately instead of by accident.
    const id = await person("po-stale", { push_enabled: true })
    const bystander = await person("po-fresh", { push_enabled: true })
    sent.mockImplementationOnce(async (msgs: { to: string }[]) =>
      msgs.map(() => ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }))
    )
    await push(id)
    await expect(db.push_tokens.count({ where: { user_id: id } })).resolves.toBe(0)
    await expect(db.push_tokens.count({ where: { user_id: bystander } })).resolves.toBe(1)
  })
})
