/**
 * Quiet hours on a `db:migrate` database (SCRUM-1276): the column and its partial index exist, the open check-in read
 * runs through the real partial index, the home city's zone comes from the seeded catalogue, and the 09:00 release
 * claims, sends once and clears on real rows. The unit suite pins the decision per kind; this pins it against Postgres.
 *
 * Only `Date` is faked (the pool's timers stay real), and Expo's client is mocked: a synthetic token answers
 * DeviceNotRegistered and the sender would delete it.
 */
const sent = jest.fn(async (msgs: Array<{ to: string; data: Record<string, unknown> }>) => msgs.map(() => ({ status: "ok", id: "t" })))
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(t: string) {
      return t.startsWith("ExponentPushToken[")
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    sendPushNotificationsAsync(chunk: Array<{ to: string; data: Record<string, unknown> }>) {
      return sent(chunk)
    }
  }
  return { Expo }
})

import { releaseHeldNotifications, sendBulkPushNotifications, sendPushNotification } from "@/lib/push-notifications"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

const users: string[] = []
const events: string[] = []
/** 23:30 IST on Thu 2026-11-26, the 09:00 IST after it, and a minute past. */
const LATE_IST = new Date("2026-11-26T18:00:00Z")
const NINE_IST = new Date("2026-11-27T03:30:00Z")
const AFTER_NINE_IST = new Date("2026-11-27T03:31:00Z")

const onlyDate = { doNotFake: ["hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] as const }
const at = (now: Date) => jest.useFakeTimers({ now, doNotFake: [...onlyDate.doNotFake] })

async function person(label: string, homeCity?: string) {
  const id = await makeUser(label)
  users.push(id)
  const home = homeCity ? await db.cities.findFirst({ where: { slug: homeCity }, select: { id: true } }) : null
  await db.profiles.create({ data: { id, name: "Test", onboarded: true, home_city_id: home?.id ?? null } })
  await db.push_tokens.create({ data: { user_id: id, token: `ExponentPushToken[itest-${id}]`, platform: "ios" } })
  return id
}

const rowsOf = (userId: string) =>
  db.notifications.findMany({ where: { user_id: userId }, select: { id: true, kind: true, held_until: true, read_at: true }, orderBy: { created_at: "asc" } })

beforeAll(() => {
  delete process.env.PUSH_QUIET_HOURS
})

beforeEach(() => sent.mockClear())

afterEach(() => jest.useRealTimers())

afterAll(async () => {
  process.env.PUSH_QUIET_HOURS = "off"
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

describe("the migration", () => {
  it("adds a nullable timestamptz held_until and its partial index", async () => {
    const [column] = await db.$queryRaw<Array<{ data_type: string; is_nullable: string }>>`
      SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'held_until'`
    expect(column).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES" })
    const [index] = await db.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'notifications' AND indexname = 'notifications_held_until_idx'`
    expect(index?.indexdef).toMatch(/\(held_until\) WHERE \(held_until IS NOT NULL\)$/)
  })
})

describe("23:30 IST", () => {
  it("a friend request to somebody at home is a bell row held to 09:00 IST, and no push", async () => {
    const home = await person("qh-home")
    at(LATE_IST)
    await expect(
      sendPushNotification({ userId: home, title: "New friend request", body: "b", data: { type: "friend_request", requestId: "r1" } })
    ).resolves.toBe(false)
    expect(sent).not.toHaveBeenCalled()
    expect(await rowsOf(home)).toEqual([expect.objectContaining({ kind: "friend_request", held_until: NINE_IST })])
  })

  it("the same match rings for somebody with an open check-in, and a DM rings for anybody", async () => {
    const out = await person("qh-out")
    const home = await person("qh-dm")
    const host = await makeUser("qh-host")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.event_check_ins.create({ data: { event_id: eventId, occurrence_id: await occurrenceOf(eventId), user_id: out, status: "checked_in" } })
    at(LATE_IST)

    await expect(sendPushNotification({ userId: out, title: "You both waved", body: "b", data: { type: "match", conversationId: "c1" } })).resolves.toBe(true)
    await expect(sendPushNotification({ userId: home, title: "Fox", body: "hey", data: { type: "private_message", conversationId: "c2" } })).resolves.toBe(true)
    expect(sent).toHaveBeenCalledTimes(2)
    expect(await rowsOf(out)).toEqual([expect.objectContaining({ kind: "match", held_until: null })])
  })

  it("an event change: the going guest not yet there rings, somebody not going is held, on the event's clock", async () => {
    const going = await person("qh-going")
    // Home in Toronto, where it is 13:00: the event's zone decides.
    const notGoing = await person("qh-not-going", "toronto")
    const host = await makeUser("qh-host2")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { timezone: "Asia/Kolkata" } })
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: going, status: "going" } })
    at(LATE_IST)

    await sendBulkPushNotifications({ userIds: [going, notGoing], title: "Friday", body: "New time", data: { type: "event_changed", eventId, changed: "time" } })

    expect(sent.mock.calls.flatMap(([msgs]) => msgs.map((m) => m.to))).toEqual([`ExponentPushToken[itest-${going}]`])
    expect(await rowsOf(going)).toEqual([expect.objectContaining({ held_until: null })])
    expect(await rowsOf(notGoing)).toEqual([expect.objectContaining({ held_until: NINE_IST })])
  })

  it("somebody whose home city is Toronto, where it is 13:00, gets the match at once", async () => {
    const toronto = await person("qh-toronto", "toronto")
    at(LATE_IST)
    await expect(sendPushNotification({ userId: toronto, title: "t", body: "b", data: { type: "match", conversationId: "c3" } })).resolves.toBe(true)
  })
})

describe("09:00 IST", () => {
  it("three held rows ring once, as the newest; a person who read theirs gets none; every hold is cleared", async () => {
    const waiting = await person("qh-waiting")
    const reader = await person("qh-reader")
    at(LATE_IST)
    for (const [minute, type] of (["friend_request", "crew_invite", "blend"] as const).entries()) {
      // Prisma stamps created_at from this process's clock: a minute apart keeps "newest" a real order.
      jest.setSystemTime(LATE_IST.getTime() + minute * 60_000)
      await sendPushNotification({ userId: waiting, title: `${type} title`, body: "b", data: { type, crewId: "k1" } })
    }
    await sendPushNotification({ userId: reader, title: "t", body: "b", data: { type: "friend_request", requestId: "r9" } })
    await db.notifications.updateMany({ where: { user_id: reader }, data: { read_at: new Date() } })
    expect(sent).not.toHaveBeenCalled()

    at(AFTER_NINE_IST)
    const result = await releaseHeldNotifications(AFTER_NINE_IST)

    // Rows held earlier in this file are due too; these two people are the ones under test.
    const mine = new Set([waiting, reader].map((id) => `ExponentPushToken[itest-${id}]`))
    const rows = await rowsOf(waiting)
    const msgs = sent.mock.calls.flatMap(([m]) => m).filter((m) => mine.has(m.to))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ to: `ExponentPushToken[itest-${waiting}]`, title: "blend title", data: { type: "blend", notificationId: rows[2].id } })
    expect(result.pushed).toBeGreaterThanOrEqual(1)
    expect(await db.notifications.count({ where: { user_id: { in: [waiting, reader] }, held_until: { not: null } } })).toBe(0)

    // A second pass finds nothing to send twice.
    sent.mockClear()
    await releaseHeldNotifications(AFTER_NINE_IST)
    expect(sent).not.toHaveBeenCalled()
  })
})
