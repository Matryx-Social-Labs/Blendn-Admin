import { randomUUID } from "crypto"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

/*
 * Expo's client, mocked as push-opt-out.itest.ts does: with a synthetic token
 * the real one answers DeviceNotRegistered and deletes the row.
 */
type Ticket = { status: string; id?: string }
const sent = jest.fn(async (msgs: { to: string; body?: string; title?: string }[]): Promise<Ticket[]> =>
  msgs.map(() => ({ status: "ok", id: "t" }))
)
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

import { performCheckout } from "@/lib/checkout"
import { db as appDb } from "@/lib/db"
import {
  expireWindows,
  forgetGoLiveCoordinates,
  MAX_EXPIRIES_PER_SWEEP,
  MAX_VENUE_DAYS_PER_SWEEP,
  sweepPresence,
  sweepVenueDays,
  TAKEOVER_PUSH_BODY,
} from "@/lib/presence-sweeper"
import { roomHandle } from "@/lib/room-handle"
import { preferredPseudonymFor } from "@/lib/anonymous-names"
import { canJoinChat } from "@/lib/socket-auth"
import { SYSTEM_USER_ID } from "@/lib/venue-day"

import { signAccessToken } from "@/lib/mobile-auth"

import { closeDb, db, makeUser, testId } from "./helpers"
import {
  checkInOf,
  cleanupWorld,
  eventParams,
  FENCE,
  goLive,
  groupParams,
  INSIDE,
  LAT,
  LNG,
  openSessionOf,
  person,
  realEvent,
  req,
  rewind,
  routes,
  sessionOf,
  venue,
  world,
} from "./go-live-world"

/**
 * The venue-day sweeper and the clock (plan v2 step 4; TQ-B05): expiry, the
 * breaker, an event taking a venue over and its push, the bounds, the reset.
 */

afterAll(async () => {
  await cleanupWorld()
  await closeDb()
}, 180_000)

beforeEach(() => sent.mockClear())

/** `n` people live at one new venue day, written directly; the door is go-live.itest.ts's. */
async function crowd(n: number, opts: { expiresInMin: number; leftAreaMinAgo?: number; leftCount?: number; createdMinAgo?: number }) {
  const v = await venue()
  const first = await person("glc")
  const { json } = await goLive(first.token, v, { minutes: 60 })
  const dayId = json.data.venueDayId as string
  await openSessionOf(dayId, first.id)
  const occurrenceId = (await db.event_occurrences.findFirstOrThrow({ where: { event_id: dayId } })).id
  const ids = [first.id]
  const more = Array.from({ length: n - 1 }, () => testId("glc"))
  await db.user.createMany({ data: more.map((id) => ({ id, email: `${id}@itest.invalid`, name: "Test crowd", role: "attendee" as const })) })
  world.users.push(...more)
  ids.push(...more)
  const arrived = new Date(Date.now() - 90 * 60_000)
  const created = new Date(Date.now() - (opts.createdMinAgo ?? 90) * 60_000)
  const expires = new Date(Date.now() + opts.expiresInMin * 60_000)
  await db.event_check_ins.deleteMany({ where: { event_id: dayId } })
  await db.presence_sessions.deleteMany({ where: { event_id: dayId } })
  await db.event_check_ins.createMany({
    data: ids.map((user_id, i) => ({
      event_id: dayId,
      occurrence_id: occurrenceId,
      user_id,
      status: "checked_in" as const,
      check_in_time: arrived,
      created_at: created,
      expires_at: expires,
      last_seen_at: arrived,
      ...(i < (opts.leftCount ?? 0) && opts.leftAreaMinAgo !== undefined && { left_area_at: new Date(Date.now() - opts.leftAreaMinAgo * 60_000) }),
    })),
  })
  await db.presence_sessions.createMany({
    data: ids.map((user_id) => ({ event_id: dayId, occurrence_id: occurrenceId, user_id, arrived_at: arrived, last_seen_at: arrived })),
  })
  return { dayId, ids, venueId: v }
}

describe("bounds (F5)", () => {
  it("drains 501 due windows over two passes, oldest end first", async () => {
    const { dayId, ids } = await crowd(501, { expiresInMin: -1 })
    // The oldest end first: one of them ended earlier than the rest.
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: ids[500] }, data: { expires_at: new Date(Date.now() - 10 * 60_000) } })
    const first = await expireWindows()
    expect(first).toBe(MAX_EXPIRIES_PER_SWEEP)
    expect((await checkInOf(dayId, ids[500])).status).toBe("checked_out")
    expect(await db.event_check_ins.count({ where: { event_id: dayId, status: "checked_in" } })).toBe(1)
    await expireWindows()
    expect(await db.event_check_ins.count({ where: { event_id: dayId, status: "checked_in" } })).toBe(0)
  }, 120_000)

  it("sweeps the venue days past the first 200 on the next pass", async () => {
    // 250 venue days, one person each who walked out half an hour ago; older
    // than anything else live, so they are the first 250 in the queue.
    const runner = await makeUser(testId("gltail"))
    world.users.push(runner)
    const now = Date.now()
    const venues = Array.from({ length: 250 }, () => ({ id: randomUUID(), name: testId("Vtail"), latitude: LAT, longitude: LNG, geofence: FENCE }))
    await db.venues.createMany({ data: venues })
    world.venues.push(...venues.map((v) => v.id))
    const days = venues.map((v) => ({
      id: randomUUID(),
      slug: `venue-day-${randomUUID()}`,
      kind: "venue_day" as const,
      title: "Venue day · tail",
      description: "",
      venue_id: v.id,
      start_time: new Date(now - 3_600_000),
      end_time: new Date(now + 20 * 3_600_000),
      timezone: "UTC",
      status: "published" as const,
      visibility: "unlisted" as const,
      organizer_id: SYSTEM_USER_ID,
      latitude: LAT,
      longitude: LNG,
      geofence: FENCE,
    }))
    await db.events.createMany({ data: days })
    const occs = days.map((d) => ({ id: randomUUID(), event_id: d.id, occurs_on: new Date(), start_time: d.start_time, end_time: d.end_time }))
    await db.event_occurrences.createMany({ data: occs })
    await db.event_check_ins.createMany({
      data: occs.map((o) => ({
        event_id: o.event_id,
        occurrence_id: o.id,
        user_id: runner,
        status: "checked_in" as const,
        check_in_time: new Date(now - 5 * 3_600_000),
        created_at: new Date(now - 5 * 3_600_000),
        expires_at: new Date(now + 3_600_000),
        left_area_at: new Date(now - 30 * 60_000),
      })),
    })
    const open = () => db.event_check_ins.count({ where: { user_id: runner, status: "checked_in" } })
    const first = await sweepVenueDays()
    expect(first.rooms.checkedOut).toBeGreaterThanOrEqual(MAX_VENUE_DAYS_PER_SWEEP - 10)
    expect(await open()).toBe(250 - MAX_VENUE_DAYS_PER_SWEEP)
    await sweepVenueDays()
    expect(await open()).toBe(0)
  }, 120_000)

  it("does not let 300 venue days starve a real event (PL-I06)", async () => {
    const runner = await makeUser(testId("gl300"))
    world.users.push(runner)
    const older = new Date(Date.now() - 6 * 3_600_000)
    const now = Date.now()
    const venues = Array.from({ length: 300 }, () => ({ id: randomUUID(), name: testId("V300"), latitude: LAT, longitude: LNG, geofence: FENCE }))
    await db.venues.createMany({ data: venues })
    world.venues.push(...venues.map((v) => v.id))
    const days = venues.map((v) => ({
      id: randomUUID(),
      slug: `venue-day-${randomUUID()}`,
      kind: "venue_day" as const,
      title: "Venue day · bound",
      description: "",
      venue_id: v.id,
      start_time: new Date(now - 3_600_000),
      end_time: new Date(now + 20 * 3_600_000),
      timezone: "Asia/Kolkata",
      status: "published" as const,
      visibility: "unlisted" as const,
      organizer_id: SYSTEM_USER_ID,
      latitude: LAT,
      longitude: LNG,
      geofence: FENCE,
    }))
    await db.events.createMany({ data: days })
    const occs = days.map((d) => ({ id: randomUUID(), event_id: d.id, occurs_on: new Date(), start_time: d.start_time, end_time: d.end_time }))
    await db.event_occurrences.createMany({ data: occs })
    await db.event_check_ins.createMany({
      data: occs.map((o) => ({
        event_id: o.event_id,
        occurrence_id: o.id,
        user_id: runner,
        status: "checked_in" as const,
        check_in_time: older,
        expires_at: new Date(now + 3_600_000),
        created_at: older,
      })),
    })

    // A real event whose day ended two hours ago, with somebody still in it:
    // newer than every venue day's check-in, so it is last in a shared queue.
    const v = await venue()
    const eventId = await realEvent(v, { startsInMin: -6 * 60 })
    await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: { end_time: new Date(now - 2 * 3_600_000) } })
    await db.events.update({ where: { id: eventId }, data: { end_time: new Date(now - 2 * 3_600_000) } })
    const occ = await db.event_occurrences.findFirstOrThrow({ where: { event_id: eventId } })
    const stale = await person("glstale")
    await db.event_check_ins.create({
      data: { event_id: eventId, occurrence_id: occ.id, user_id: stale.id, status: "checked_in", check_in_time: new Date(now - 60 * 60_000), created_at: new Date(now - 60 * 60_000) },
    })

    await sweepPresence()
    expect((await checkInOf(eventId, stale.id)).status).toBe("checked_out")

    // Out of everybody else's way.
    await db.events.deleteMany({ where: { id: { in: days.map((d) => d.id) } } })
  }, 120_000)
})

describe("expiry and the breaker (D-20)", () => {
  it("expires fifty windows that end together without tripping the breaker (PL-I04)", async () => {
    const { dayId } = await crowd(50, { expiresInMin: -1, createdMinAgo: 10 })
    const result = await sweepVenueDays()
    expect(result.expired).toBeGreaterThanOrEqual(50)
    expect(result.rooms.guarded).not.toContain(dayId)
    expect(await db.event_check_ins.count({ where: { event_id: dayId, status: "checked_in" } })).toBe(0)
    expect(await db.presence_sessions.count({ where: { event_id: dayId, departed_source: "expired" } })).toBe(50)
  })

  it("still trips the breaker on an out-of-fence burst at a venue day (PL-I05)", async () => {
    // 6 of 8 out of the fence for longer than the allowance, windows still open.
    const { dayId } = await crowd(8, { expiresInMin: 30, leftAreaMinAgo: 30, leftCount: 6, createdMinAgo: 10 })
    const result = await sweepVenueDays()
    expect(result.rooms.guarded).toContain(dayId)
    expect(await db.event_check_ins.count({ where: { event_id: dayId, status: "checked_in" } })).toBe(8)
  })

  it("expires each window once when two sweepers run at once (two replicas)", async () => {
    const { dayId } = await crowd(12, { expiresInMin: -1, createdMinAgo: 10 })
    const [a, b] = await Promise.all([expireWindows(), expireWindows()])
    expect(a + b).toBeGreaterThanOrEqual(12)
    expect(await db.presence_sessions.count({ where: { event_id: dayId, departed_source: "expired" } })).toBe(12)
    expect(await db.presence_sessions.count({ where: { event_id: dayId, departed_at: null } })).toBe(0)
  })

  it("expires a window that ends at a sub-millisecond instant", async () => {
    const { dayId, ids } = await crowd(2, { expiresInMin: 30, createdMinAgo: 10 })
    await db.$executeRaw`UPDATE event_check_ins SET expires_at = now() - interval '1 minute' + interval '0.000500 second' WHERE event_id = ${dayId}::uuid AND user_id = ${ids[1]}`
    await expireWindows()
    expect((await checkInOf(dayId, ids[1])).status).toBe("checked_out")
  })

  it("leaves a window alone that was extended after the sweep read it", async () => {
    const { dayId, ids } = await crowd(1, { expiresInMin: -1, createdMinAgo: 10 })
    const row = await checkInOf(dayId, ids[0])
    // Went live again between the read and the write.
    await db.event_check_ins.update({ where: { id: row.id }, data: { expires_at: new Date(Date.now() + 20 * 60_000) } })
    const done = await performCheckout(row.id, "expired", row.expires_at!)
    expect(done?.changed).toBe(false)
    expect((await checkInOf(dayId, ids[0])).status).toBe("checked_in")
  })
})

describe("stay, against the sweeper", () => {
  it("does not reopen a window the sweeper closed between the ping's read and its write", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v, { stay: true })
    const dayId = json.data.venueDayId
    await openSessionOf(dayId, me.id)
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: me.id }, data: { expires_at: new Date(Date.now() + 2 * 60_000) } })
    const stale = await appDb.event_check_ins.findFirst({
      where: { event_id: dayId, user_id: me.id, status: "checked_in" },
      select: {
        id: true, kind: true, last_seen_at: true, left_area_at: true, departure_prompted_at: true,
        expires_at: true, stay_until: true, stay: true,
        occurrence: { select: { id: true, end_time: true } },
        event: { select: { geofence: true, latitude: true, longitude: true, check_in_radius: true } },
      },
    })
    // The sweep wins the race: checked out, the room cut.
    await performCheckout(stale!.id, "manual")
    const cut = (await db.chat_group_members.findFirstOrThrow({ where: { user_id: me.id, chat_group: { event_id: dayId } } })).last_allowed_at
    // The ping read the row before that.
    const spy = jest.spyOn(appDb.event_check_ins, "findFirst").mockResolvedValueOnce(stale as never)
    try {
      const res = await routes.presence.POST(req(`/api/mobile/events/${dayId}/presence`, me.token, "POST", { ...INSIDE, accuracy: 10 }), eventParams(dayId))
      expect(res.status).toBe(200)
    } finally {
      spy.mockRestore()
    }
    const member = await db.chat_group_members.findFirstOrThrow({ where: { user_id: me.id, chat_group: { event_id: dayId } } })
    expect(member.last_allowed_at?.toISOString()).toBe(cut?.toISOString())
    expect(await canJoinChat(me.id, json.data.chatGroupId)).toBe(false)
  })

  it("is carried on by an in-fence ping, and stops at its cap (PL-I07)", async () => {
    const v = await venue()
    const me = await person()
    const ping = () =>
      routes.presence.POST(req(`/api/mobile/events/${dayId}/presence`, me.token, "POST", { ...INSIDE, accuracy: 10 }), eventParams(dayId))
    const { json } = await goLive(me.token, v, { stay: true })
    const dayId = json.data.venueDayId
    expect(json.data.stay).toBe(true)
    expect(new Date(json.data.stayUntil).getTime() - Date.now()).toBeGreaterThan(3.9 * 3_600_000)

    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: me.id }, data: { expires_at: new Date(Date.now() + 5 * 60_000) } })
    const moved = new Date((await (await ping()).json()).data.expiresAt).getTime()
    expect(moved - Date.now()).toBeGreaterThan(15 * 60_000)
    const member = await db.chat_group_members.findFirstOrThrow({ where: { user_id: me.id, chat_group: { event_id: dayId } } })
    expect(member.last_allowed_at?.getTime()).toBe(moved)

    const cap = new Date(Date.now() + 8 * 60_000)
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: me.id }, data: { stay_until: cap } })
    await ping()
    expect((await checkInOf(dayId, me.id)).expires_at?.getTime()).toBe(moved)
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: me.id }, data: { expires_at: new Date(Date.now() + 60_000) } })
    await ping()
    expect((await checkInOf(dayId, me.id)).expires_at?.getTime()).toBe(cap.getTime())
  })

  it("is not given to a fixed window, and a ping past the end checks you out", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v, { minutes: 20 })
    const dayId = json.data.venueDayId
    await openSessionOf(dayId, me.id)
    const ping = () =>
      routes.presence.POST(req(`/api/mobile/events/${dayId}/presence`, me.token, "POST", { ...INSIDE, accuracy: 10 }), eventParams(dayId))
    await ping()
    expect((await checkInOf(dayId, me.id)).expires_at?.toISOString()).toBe(json.data.expiresAt)

    await rewind(dayId, me.id, 25)
    expect((await (await ping()).json()).data).toMatchObject({ status: "checked_out", reason: "expired" })
    expect((await sessionOf(dayId, me.id)).departed_source).toBe("expired")
  })
})

describe("an event takes the venue over (PL-I10, D-x3)", () => {
  async function liveWithPhones(n: number, opts: { pushOff?: number } = {}) {
    const v = await venue()
    const people = []
    for (let i = 0; i < n; i++) {
      const p = await person("gls")
      await db.push_tokens.create({ data: { user_id: p.id, token: `ExponentPushToken[gl-${p.id}]`, platform: "ios" } })
      if (i < (opts.pushOff ?? 0)) await db.profiles.update({ where: { id: p.id }, data: { push_enabled: false } })
      people.push(p)
    }
    const lives = []
    for (const p of people) lives.push(await goLive(p.token, v, { minutes: 60 }))
    for (const p of people) await openSessionOf(lives[0].json.data.venueDayId, p.id)
    return { v, people, dayId: lives[0].json.data.venueDayId as string, groupId: lives[0].json.data.chatGroupId as string }
  }
  const messagesTo = (userId: string) => sent.mock.calls.flatMap((c) => c[0]).filter((m) => m.to === `ExponentPushToken[gl-${userId}]`)

  it("closes everybody live as ended, and pushes each once, in our words, never the event's", async () => {
    const { v, people, dayId, groupId } = await liveWithPhones(3, { pushOff: 1 })
    const eventId = await realEvent(v, { startsInMin: -1, link: "confirmed" })
    const title = (await db.events.findUniqueOrThrow({ where: { id: eventId } })).title

    // Two replicas at once: one batch of pushes.
    await Promise.all([sweepVenueDays(), sweepVenueDays()])
    for (const p of people) {
      expect((await checkInOf(dayId, p.id)).status).toBe("checked_out")
      expect((await sessionOf(dayId, p.id)).departed_source).toBe("ended")
      expect(await canJoinChat(p.id, groupId)).toBe(false)
    }
    // A bell row for each; a push only where the person allows it.
    const notes = await db.notifications.findMany({ where: { user_id: { in: people.map((p) => p.id) } } })
    expect(notes).toHaveLength(3)
    for (const n of notes) {
      expect(n).toMatchObject({ kind: "event_update", body: TAKEOVER_PUSH_BODY })
      expect(n.data).toMatchObject({ eventId })
      expect(`${n.title} ${n.body}`).not.toContain(title)
    }
    expect(messagesTo(people[0].id)).toHaveLength(0)
    expect(messagesTo(people[1].id)).toHaveLength(1)
    expect(messagesTo(people[2].id)).toHaveLength(1)
    expect(messagesTo(people[1].id)[0].body).toBe(TAKEOVER_PUSH_BODY)

    // A later pass sends nothing more.
    sent.mockClear()
    await sweepVenueDays()
    expect(sent).not.toHaveBeenCalled()
    expect(await db.notifications.count({ where: { user_id: { in: people.map((p) => p.id) } } })).toBe(3)
  })

  it("pushes each person once when two events start at one venue", async () => {
    const { v, people } = await liveWithPhones(2)
    await realEvent(v, { startsInMin: -2, link: "confirmed" })
    await realEvent(v, { startsInMin: -1, link: "confirmed" })
    await sweepVenueDays()
    for (const p of people) expect(messagesTo(p.id)).toHaveLength(1)
  })

  it.each([
    ["a private event", { visibility: "private" as const, link: null }],
    ["an event linked from a kilometre away, unconfirmed", { link: "auto_linked" as const, far: true }],
    ["a day of the event called off", { link: "confirmed" as const, cancelled: true }],
    ["an event that ended a minute ago", { link: "confirmed" as const, startsInMin: -61, hours: 1 }],
    ["an event starting in a minute", { link: "confirmed" as const, startsInMin: 1 }],
  ])("closes nothing and sends nothing for %s", async (_label, opts) => {
    const { v, people, dayId } = await liveWithPhones(1)
    await realEvent(v, { startsInMin: -1, ...opts })
    await sweepVenueDays()
    expect((await checkInOf(dayId, people[0].id)).status).toBe("checked_in")
    expect(messagesTo(people[0].id)).toHaveLength(0)
  })

  it("leaves somebody too young for the event live, and closes the rest (D-3)", async () => {
    const young = await person("gly", { age: 19 })
    const older = await person("glo", { age: 25 })

    // Go Live is not refused in favour of a 21+ event they could not enter.
    const soon = await venue()
    await realEvent(soon, { startsInMin: 30, minAge: 21, link: "confirmed" })
    expect((await goLive(young.token, soon)).status).toBe(200)
    expect((await goLive(older.token, soon)).status).toBe(409)

    const v = await venue()
    const [y, o] = [await goLive(young.token, v, { minutes: 60 }), await goLive(older.token, v, { minutes: 60 })]
    expect([y.status, o.status]).toEqual([200, 200])
    const eventId = await realEvent(v, { startsInMin: -1, minAge: 21, link: "confirmed" })
    await sweepVenueDays()
    const dayId = y.json.data.venueDayId
    expect((await checkInOf(dayId, young.id)).status).toBe("checked_in")
    expect((await checkInOf(dayId, older.id)).status).toBe("checked_out")
    const told = (id: string) => db.notifications.count({ where: { user_id: id, data: { path: ["eventId"], equals: eventId } } })
    expect(await told(young.id)).toBe(0)
    expect(await told(older.id)).toBe(1)
  })
})

describe("coordinates are kept a few days", () => {
  it("drops where somebody stood three days after the window ended, and not before", async () => {
    const { dayId, ids } = await crowd(2, { expiresInMin: 30, createdMinAgo: 10 })
    await db.event_check_ins.updateMany({ where: { event_id: dayId }, data: { latitude: LAT, longitude: LNG } })
    await db.presence_sessions.updateMany({ where: { event_id: dayId }, data: { last_lat: LAT, last_lng: LNG } })
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: ids[0] }, data: { expires_at: new Date(Date.now() - 4 * 86_400_000), status: "checked_out" } })
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: ids[1] }, data: { expires_at: new Date(Date.now() - 2 * 86_400_000), status: "checked_out" } })
    await forgetGoLiveCoordinates()
    expect(await checkInOf(dayId, ids[0])).toMatchObject({ latitude: null, longitude: null })
    expect((await sessionOf(dayId, ids[0])).last_lat).toBeNull()
    expect(await checkInOf(dayId, ids[1])).toMatchObject({ latitude: LAT, longitude: LNG })
    expect((await sessionOf(dayId, ids[1])).last_lat).toBe(LAT)
  })
})

describe("the daily reset, in the venue's clock (PL-I15, D-4, D-5)", () => {
  // Only the clock is moved; it runs on from wherever it is set. Tokens are
  // signed after it moves, or they would read as expired (or not yet issued).
  const onlyDate = ["nextTick", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "queueMicrotask", "hrtime", "performance"] as const
  beforeEach(() => jest.useFakeTimers({ advanceTimers: true, doNotFake: [...onlyDate] }))
  afterEach(() => jest.useRealTimers())
  const at = (iso: string) => jest.setSystemTime(new Date(iso))
  const tokenOf = (id: string) => signAccessToken(id, `${id}@itest.invalid`)

  it("ends a window at 06:00, opens a new room at 06:05, and keeps yesterday's shut", async () => {
    const v = await venue({ timezone: "Asia/Kolkata", resetHour: 6 })
    const [a, b] = [await person(), await person()]

    at("2026-10-05T00:25:00Z") // 05:55 IST
    const night = await goLive(tokenOf(a.id), v, { minutes: 20 })
    expect(night.status).toBe(200)
    expect(night.json.data.expiresAt).toBe("2026-10-05T00:30:00.000Z")
    await openSessionOf(night.json.data.venueDayId, a.id)

    at("2026-10-05T00:31:00Z") // 06:01
    await sweepVenueDays()
    const ended = await sessionOf(night.json.data.venueDayId, a.id)
    expect(ended.departed_source).toBe("expired")
    expect(ended.departed_at?.toISOString()).toBe("2026-10-05T00:30:00.000Z")

    at("2026-10-05T00:35:00Z") // 06:05
    const morning = await goLive(tokenOf(a.id), v, { minutes: 20 })
    const bMorning = await goLive(tokenOf(b.id), v, { minutes: 20 })
    expect(morning.json.data.venueDayId).not.toBe(night.json.data.venueDayId)
    expect(morning.json.data.chatGroupId).not.toBe(night.json.data.chatGroupId)
    // New handles and new pseudonyms with the new day.
    expect(roomHandle(morning.json.data.venueDayId, a.id)).not.toBe(roomHandle(night.json.data.venueDayId, a.id))
    expect(preferredPseudonymFor(morning.json.data.venueDayId, a.id, "keyed")).not.toBe(
      preferredPseudonymFor(night.json.data.venueDayId, a.id, "keyed")
    )
    // Yesterday's room: not to a day-two member, not to its own, and it takes no posts.
    expect(await canJoinChat(b.id, night.json.data.chatGroupId)).toBe(false)
    expect(await canJoinChat(a.id, night.json.data.chatGroupId)).toBe(false)
    const post = await routes.messages.POST(
      req(`/api/mobile/chat/groups/${night.json.data.chatGroupId}/messages`, tokenOf(a.id), "POST", { content: "still here?" }),
      groupParams(night.json.data.chatGroupId)
    )
    expect(post.status).toBe(403)
    expect(bMorning.status).toBe(200)
  })

  it("opens tomorrow's room for a Go Live in the last minutes before the reset", async () => {
    const v = await venue({ timezone: "Asia/Kolkata", resetHour: 6 })
    const me = await person()
    at("2026-10-06T00:29:59.500Z") // 05:59:59.5 IST
    const { status, json } = await goLive(tokenOf(me.id), v, { minutes: 20 })
    expect(status).toBe(200)
    const day = await db.events.findUniqueOrThrow({ where: { id: json.data.venueDayId } })
    expect(day.start_time.toISOString()).toBe("2026-10-06T00:30:00.000Z")
    // Twenty minutes, in tomorrow's room — not half a second in today's.
    const expires = new Date(json.data.expiresAt).getTime()
    expect(expires - new Date("2026-10-06T00:29:59.500Z").getTime()).toBeGreaterThanOrEqual(20 * 60_000)
    expect(expires - new Date("2026-10-06T00:29:59.500Z").getTime()).toBeLessThan(20 * 60_000 + 5_000)
  })

  it.each([
    // 22:00 the evening before each change, in the day that spans it.
    ["the clocks go back: a 25-hour day", "2026-10-24T20:00:00Z", 25],
    ["the clocks go forward: a 23-hour day", "2026-03-28T21:00:00Z", 23],
  ])("counts a Berlin day in Berlin's clock: %s", async (_label, when, hours) => {
    const v = await venue({ timezone: "Europe/Berlin", resetHour: 6 })
    const me = await person()
    at(when)
    const { json } = await goLive(tokenOf(me.id), v, { minutes: 20 })
    const day = await db.events.findUniqueOrThrow({ where: { id: json.data.venueDayId } })
    expect(day.end_time.getTime() - day.start_time.getTime()).toBe(hours * 3_600_000)
  })
})
