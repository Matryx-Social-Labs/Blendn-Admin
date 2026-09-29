import { NextRequest } from "next/server"

/*
 * IT Rules 2021, r.3(1)(h): what a person registered with survives the
 * deletion of their account for 180 days, and then goes.
 *
 * Real route, real transaction, real rows — the unit suite can only show the
 * copy is IN the batch; this shows Postgres commits it with the scrub, rolls
 * it back with a failed one, and that the purge takes exactly the expired.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockStorageConfigured = jest.fn(() => true)
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0), isConfigured: () => mockStorageConfigured() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { purgeDeletedAccountRecords, recordDeletedAccount } from "@/lib/deleted-account-records"
import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"
import { deletePrefix } from "@/lib/tigris"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")

const DAY_MS = 24 * 60 * 60 * 1000
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.deleted_account_records.deleteMany({ where: { user_id: { in: users } } })
  await db.user_oauth_accounts.deleteMany({ where: { user_id: { in: users } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function deleteAccount(id: string) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return accountRoute.DELETE(
    new NextRequest("http://localhost/api/mobile/account", {
      method: "DELETE",
      headers: { authorization: `Bearer ${signAccessToken(id, email)}` },
    })
  )
}

it("writes exactly one record of what they registered with, and still erases the account", async () => {
  const id = await makeUser("dar-google")
  users.push(id)
  const { email, createdAt } = await db.user.findUniqueOrThrow({ where: { id } })
  await db.profiles.create({
    data: { id, name: "Asha Rao", phone: "+919800000001", date_of_birth: new Date("1996-05-12"), onboarded: true },
  })
  // A Google sign-up: an OAuth link and no password.
  await db.user_oauth_accounts.create({
    data: { user_id: id, provider: "google", provider_id: `sub-${id}`, email },
  })

  const res = await deleteAccount(id)
  expect(res.status).toBe(200)

  const user = await db.user.findUniqueOrThrow({ where: { id } })
  const records = await db.deleted_account_records.findMany({ where: { user_id: id } })
  expect(records).toHaveLength(1)
  const [r] = records
  expect(r).toMatchObject({
    name: "Asha Rao",
    email,
    phone: "+919800000001",
    date_of_birth: new Date("1996-05-12"),
    account_created_at: createdAt,
    sign_up_method: "google",
  })
  // The same instant the User row was stamped with, and 180 days on from it.
  expect(r.deleted_at).toEqual(user.deletedAt)
  expect(r.purge_after.getTime() - r.deleted_at.getTime()).toBe(180 * DAY_MS)

  // The rest of the contract: the live rows are erased all the same.
  expect(user).toMatchObject({ name: null, password: null, email: `deleted-${id}@deleted.blendn.invalid` })
  expect(await db.profiles.findUniqueOrThrow({ where: { id } })).toMatchObject({
    name: null,
    phone: null,
    date_of_birth: null,
  })
  expect(await db.user_oauth_accounts.count({ where: { user_id: id } })).toBe(0)

  // An erased account is never copied again: a second copy would be the husk.
  expect(await recordDeletedAccount(id, new Date())).toBe(0)
  expect(await db.deleted_account_records.count({ where: { user_id: id } })).toBe(1)
})

it("records a password account as an email sign-up", async () => {
  const id = await makeUser("dar-email")
  users.push(id)
  await db.user.update({ where: { id }, data: { password: "$2a$10$notarealhashnotarealhashnotarealhashnotarealhashnot" } })
  await db.profiles.create({ data: { id, name: "Ravi", onboarded: true } })

  expect((await deleteAccount(id)).status).toBe(200)

  const [r] = await db.deleted_account_records.findMany({ where: { user_id: id } })
  expect(r).toMatchObject({ sign_up_method: "email", name: "Ravi", phone: null, date_of_birth: null })
})

it("keeps a board post moderation took down, and deletes the rest of theirs", async () => {
  /*
   * r.3(1)(g): removed content and the record of its removal are kept for 180
   * days. The hidden row is both, and the author's deletion was hard-deleting
   * it along with their live posts.
   */
  const host = await makeUser("dar-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const id = await makeUser("dar-poster")
  users.push(id)
  await db.profiles.create({ data: { id, name: "Poster", onboarded: true } })
  const [live, hidden] = await Promise.all([
    db.board_posts.create({ data: { event_id: eventId, author_id: id, kind: "chat", body: "anyone for chai" } }),
    db.board_posts.create({
      data: {
        event_id: eventId,
        author_id: id,
        kind: "chat",
        body: "something the moderator took down",
        moderation_status: "hidden",
        deleted_at: new Date(),
      },
    }),
  ])

  expect((await deleteAccount(id)).status).toBe(200)

  const left = await db.board_posts.findMany({ where: { id: { in: [live.id, hidden.id] } }, select: { id: true, body: true } })
  expect(left).toEqual([{ id: hidden.id, body: "something the moderator took down" }])
})

it("leaves no copy when the deletion fails", async () => {
  // No profile row, so `profiles.update` throws and the batch rolls back.
  const id = await makeUser("dar-fails")
  users.push(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id } })

  expect((await deleteAccount(id)).status).toBe(500)

  expect(await db.deleted_account_records.count({ where: { user_id: id } })).toBe(0)
  expect(await db.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ email, deletedAt: null })
})

it("purges only the records past their date, and a second pass purges nothing", async () => {
  // A fixed clock in the past, so no real record (180 days from today) is due.
  const now = new Date("2000-01-01T00:00:00Z")
  const row = (label: string, purge_after: Date) => {
    const user_id = `itest_dar-purge-${label}_${Math.random().toString(36).slice(2, 10)}`
    users.push(user_id)
    return {
      user_id,
      email: `${user_id}@itest.invalid`,
      account_created_at: new Date("1999-01-01T00:00:00Z"),
      deleted_at: new Date(purge_after.getTime() - 180 * DAY_MS),
      sign_up_method: "email",
      purge_after,
    }
  }
  const expired = row("expired", new Date(now.getTime() - 1))
  const due = row("due", now)
  const live = row("live", new Date(now.getTime() + DAY_MS))
  await db.deleted_account_records.createMany({ data: [expired, due, live] })

  expect(await purgeDeletedAccountRecords(now)).toBe(1)
  const left = await db.deleted_account_records.findMany({
    where: { user_id: { in: [expired.user_id, due.user_id, live.user_id] } },
    select: { user_id: true },
  })
  expect(left.map((r) => r.user_id).sort()).toEqual([due.user_id, live.user_id].sort())

  expect(await purgeDeletedAccountRecords(now)).toBe(0)
})

/*
 * SCRUM-429. Account deletion keeps a person's removed-content chat images for
 * their 180 days (retainedChatMediaKeys), and nothing ever deleted them after.
 * They go with the registration record: same period, same sweep.
 */
it("erases what is left of the person's chat media with their record, and keeps a record whose media it could not erase", async () => {
  const now = new Date()
  const make = async (label: string) => {
    const user_id = await makeUser(label)
    users.push(user_id)
    await db.deleted_account_records.create({
      data: {
        user_id,
        email: `${user_id}@itest.invalid`,
        account_created_at: new Date("1999-01-01T00:00:00Z"),
        deleted_at: new Date(now.getTime() - 181 * DAY_MS),
        sign_up_method: "email",
        purge_after: new Date(now.getTime() - DAY_MS),
      },
    })
    return user_id
  }
  const erased = await make("purge-media-ok")
  const stuck = await make("purge-media-fails")
  const mocked = deletePrefix as jest.Mock
  mocked.mockReset()
  mocked.mockImplementation(async (prefix: string) => {
    // deletePrefix throws when anything under the prefix was left (a refusal or a timeout).
    if (prefix === `chat/${stuck}/`) throw new Error("deletePrefix: 1 object(s) under chat/ not deleted")
    return 2
  })

  // Other cases in this file leave records of their own, so read ours rather than the sweep's count.
  await purgeDeletedAccountRecords(now)
  // Everything under the prefix: the 180 days were the only reason to keep any of it.
  expect(mocked).toHaveBeenCalledWith(`chat/${erased}/`)
  // And profile/, whose erasure at deletion is never retried otherwise.
  expect(mocked).toHaveBeenCalledWith(`profile/${erased}/`)
  const left = await db.deleted_account_records.findMany({ where: { user_id: { in: [erased, stuck] } }, select: { user_id: true } })
  expect(left.map((r) => r.user_id)).toEqual([stuck])

  // Storage back: the next sweep takes it.
  mocked.mockResolvedValue(0)
  await purgeDeletedAccountRecords(now)
  expect(await db.deleted_account_records.count({ where: { user_id: { in: [erased, stuck] } } })).toBe(0)
})

it("keeps every due record when storage is not configured: the erasure cannot be done, and the record is the pointer", async () => {
  const now = new Date()
  const user_id = await makeUser("purge-no-storage")
  users.push(user_id)
  await db.deleted_account_records.create({
    data: {
      user_id,
      email: `${user_id}@itest.invalid`,
      account_created_at: new Date("1999-01-01T00:00:00Z"),
      deleted_at: new Date(now.getTime() - 181 * DAY_MS),
      sign_up_method: "email",
      purge_after: new Date(now.getTime() - DAY_MS),
    },
  })
  mockStorageConfigured.mockReturnValueOnce(false)
  expect(await purgeDeletedAccountRecords(now)).toBe(0)
  expect(await db.deleted_account_records.count({ where: { user_id } })).toBe(1)
})
