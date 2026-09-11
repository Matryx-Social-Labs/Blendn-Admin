import { sendPushNotification } from "@/lib/push-notifications"
import { closeDb, db, makeUser, testId } from "./helpers"

/**
 * `push_enabled` decides whether a push goes out — evaluated by Postgres.
 *
 * The unit test pins the SHAPE of the filter (`NOT: { user: { profile: { is:
 * { push_enabled: false } } } }`). The filter's own docstring says why the
 * shape matters: an inclusive filter would drop everyone with no `profiles`
 * row. That is a claim about how Postgres evaluates a relation filter, and
 * only Postgres can confirm it. Three people, one token each: opted out,
 * opted in, and no profile row at all.
 *
 * `sendPushNotification` is asked, not the private selector, so this is the
 * real send path: it returns false when nobody is reachable and never calls
 * Expo for an opted-out person (the fake token below would be rejected as
 * invalid before any network call anyway — this asserts on selection, which
 * is the part the switch controls).
 */
const users: string[] = []

afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function person(label: string, profile: { push_enabled: boolean } | null) {
  const id = await makeUser(testId(label))
  users.push(id)
  if (profile) await db.profiles.create({ data: { id, ...profile } })
  await db.push_tokens.create({
    data: { user_id: id, token: `ExponentPushToken[itest-${id}]`, platform: "ios" },
  })
  return id
}

describe("the switch is honoured on the send path", () => {
  it("opted out: no token is selected, so nothing is sent", async () => {
    const id = await person("po-off", { push_enabled: false })
    await expect(
      sendPushNotification({ userId: id, title: "t", body: "b", data: { type: "event_update" } })
    ).resolves.toBe(false)
    // And the token is untouched: nothing was attempted, so nothing was
    // cleaned up. Turning the switch back on must find it again.
    await expect(db.push_tokens.count({ where: { user_id: id } })).resolves.toBe(1)
  })

  it("opted in: the token is selected", async () => {
    const id = await person("po-on", { push_enabled: true })
    // Selection only. Calling the sender here reaches Expo with a synthetic
    // token, Expo answers DeviceNotRegistered, and the sender then DELETES
    // the row -- the stale-token cleanup working -- which is a different
    // thing from the switch and would make this assertion read as the switch
    // failing. (That is exactly what the first version of this test did.)
    const tokens = await db.push_tokens.findMany({
      where: { user_id: id, NOT: { user: { profile: { is: { push_enabled: false } } } } },
    })
    expect(tokens).toHaveLength(1)
  })

  it("no profile row at all: still reachable — the column's default is true", async () => {
    const id = await person("po-none", null)
    const tokens = await db.push_tokens.findMany({
      where: { user_id: id, NOT: { user: { profile: { is: { push_enabled: false } } } } },
    })
    expect(tokens).toHaveLength(1)
  })
})
