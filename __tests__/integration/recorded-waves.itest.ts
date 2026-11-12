import { NextRequest } from "next/server"

/*
 * Recorded waves against a real database (SCRUM-1042, SCRUM-1050; owner ruling
 * 2026-11-12, Wave replaces Like for people): the unique key and its race, the
 * stored caps at their boundaries (W3-W6), the mutual through the like-match
 * path and its one push, an old like read as a hidden wave and never shown,
 * answering after leaving, and who the received list and Banter's rows hide.
 * Every rule has its control beside it.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-recorded-waves-secret-of-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { logger } from "@/lib/logger"
import { signAccessToken } from "@/lib/mobile-auth"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { roomHandle } from "@/lib/room-handle"
import { WAVE_LIMITS, waveCapFor } from "@/lib/waves"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const wavesRoute = require("@/app/api/mobile/events/[eventId]/waves/route") as typeof import("@/app/api/mobile/events/[eventId]/waves/route")
const waitingRoute = require("@/app/api/mobile/waves/route") as typeof import("@/app/api/mobile/waves/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
  pseudonym: string
}

const DAY = 24 * 60 * 60 * 1000
const MONTH_AGO = new Date(Date.now() - 30 * DAY)
const users: string[] = []
const events: string[] = []
const orgs: string[] = []

let eventId: string
let occurrenceId: string
let groupId: string

async function person(label: string, opts: { fresh?: boolean } = {}): Promise<Person> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  // Most fixtures are a month old: a new account has its own caps (W5), tested on purpose below.
  if (!opts.fresh) await db.user.update({ where: { id }, data: { createdAt: MONTH_AGO } })
  const pseudonym = testId(`Zq ${label}`)
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: id, anonymous_name: pseudonym } })
  await putInRoom({ eventId, occurrenceId, userId: id })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`), pseudonym }
}

async function call(handler: unknown, path: string, as: Person, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const res = await (handler as Handler)(
    new NextRequest(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve(opts.params ?? {}) as Promise<never> }
  )
  return { status: res.status, body: await res.json() }
}

const wave = (from: Person, to: Person | string, event: string = eventId) =>
  call(wavesRoute.POST, `/api/mobile/events/${event}/waves`, from, {
    method: "POST",
    body: { toUserId: typeof to === "string" ? to : roomHandle(event, to.id) },
    params: { eventId: event },
  })
const received = (as: Person, cursor?: string) =>
  call(wavesRoute.GET, `/api/mobile/events/${eventId}/waves${cursor ? `?cursor=${cursor}` : ""}`, as, { params: { eventId } })
const leave = (p: Person) =>
  db.event_check_ins.updateMany({ where: { event_id: eventId, user_id: p.id }, data: { status: "checked_out", check_out_time: new Date() } })
const rowsBetween = (a: Person, b: Person) => db.event_waves.count({ where: { event_id: eventId, from_id: a.id, to_id: b.id } })
const matchBells = (p: Person) => db.notifications.findMany({ where: { user_id: p.id, kind: "match" }, select: { body: true } })

/** Bulk strangers to wave at (or to wave): no profile row, which the roster reads as listed. */
async function strangers(n: number, label: string): Promise<string[]> {
  const ids = Array.from({ length: n }, (_, i) => testId(`${label}${i}`))
  await db.user.createMany({ data: ids.map((id) => ({ id, email: `${id}@itest.invalid`, name: `Test ${id}`, createdAt: MONTH_AGO })) })
  users.push(...ids)
  return ids
}
const seedWaves = (rows: { from: string; to: string; event?: string; at?: Date }[]) =>
  db.event_waves.createMany({ data: rows.map((r) => ({ event_id: r.event ?? eventId, from_id: r.from, to_id: r.to, created_at: r.at ?? new Date() })) })

beforeAll(async () => {
  const host = await makeUser("rw-host", "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
  occurrenceId = await occurrenceOf(eventId)
  groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room" }, select: { id: true } })).id
}, 30_000)

beforeEach(() => resetMemoryStore())

afterAll(async () => {
  await db.event_waves.deleteMany({ where: { OR: [{ from_id: { in: users } }, { to_id: { in: users } }] } })
  await db.event_likes.deleteMany({ where: { OR: [{ liker_id: { in: users } }, { liked_id: { in: users } }] } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("one wave per pair per room, recorded", () => {
  it("stores a row, lists it for them by handle and pseudonym, and for the sender lists nothing", async () => {
    const ana = await person("rw-ana")
    const ben = await person("rw-ben")
    const sent = await wave(ana, ben)
    expect(sent).toEqual({ status: 200, body: { success: true, data: { sent: true, mutual: false } } })
    expect(await rowsBetween(ana, ben)).toBe(1)

    const list = await received(ben)
    expect(list.body.data).toEqual({
      open: true,
      total: 1,
      nextCursor: null,
      waves: [{ userId: roomHandle(eventId, ana.id), displayName: ana.pseudonym, wavedAt: expect.any(String), wavedBack: false }],
    })
    expect(JSON.stringify(list.body)).not.toContain(ana.id)
    expect((await received(ana)).body.data.total).toBe(0)
  })

  it("W1: a second wave is the same 200 and no second row, and there is no 'wave again' after ten minutes", async () => {
    const ana = await person("rw-w1a")
    const ben = await person("rw-w1b")
    const first = await wave(ana, ben)
    resetMemoryStore() // the 10-minute live window gone: still one per room
    expect(await wave(ana, ben)).toEqual(first)
    expect(await rowsBetween(ana, ben)).toBe(1)
  })

  it("W1 under a race: two waves at once leave one row", async () => {
    const ana = await person("rw-race-a")
    const ben = await person("rw-race-b")
    const both = await Promise.all([wave(ana, ben), wave(ana, ben)])
    expect(both.map((r) => r.status)).toEqual([200, 200])
    expect(await rowsBetween(ana, ben)).toBe(1)
  })

  it("the database refuses a duplicate and a self-wave whoever writes", async () => {
    const ana = await person("rw-db-a")
    const ben = await person("rw-db-b")
    await seedWaves([{ from: ana.id, to: ben.id }])
    await expect(seedWaves([{ from: ana.id, to: ben.id }])).rejects.toThrow()
    await expect(seedWaves([{ from: ana.id, to: ana.id }])).rejects.toThrow(/event_waves_not_self/)
  })
})

describe("two waves open the anonymous conversation; the push goes to the first waver only", () => {
  it("answers the second waver with the moment, and pushes 'You and {pseudonym} both waved' to the first", async () => {
    const ana = await person("rw-m-a")
    const ben = await person("rw-m-b")
    await wave(ana, ben)
    const back = await wave(ben, ana)
    expect(back.body.data).toEqual({
      sent: true,
      mutual: true,
      conversationId: expect.any(String),
      pseudonyms: { you: ben.pseudonym, them: ana.pseudonym },
    })
    const convo = await db.private_conversations.findUnique({ where: { id: back.body.data.conversationId }, select: { origin_event_id: true } })
    expect(convo?.origin_event_id).toBe(eventId)
    // The push was fired and forgotten: let it land.
    await new Promise((r) => setTimeout(r, 300))
    expect(await matchBells(ana)).toEqual([{ body: `You and ${ben.pseudonym} both waved` }])
    expect(await matchBells(ben)).toEqual([])
    // ben's list now shows ana's wave as answered.
    expect((await received(ben)).body.data.waves[0].wavedBack).toBe(true)
  })

  it("control: a one-way wave pushes nobody", async () => {
    const ana = await person("rw-np-a")
    const ben = await person("rw-np-b")
    await wave(ana, ben)
    await new Promise((r) => setTimeout(r, 200))
    expect(await matchBells(ben)).toEqual([])
    expect(await matchBells(ana)).toEqual([])
  })
})

describe("an old like is a hidden wave: it completes a mutual and is never shown (approval 11)", () => {
  it("is not on the list, nor on the deck's wavedAtYou, and a wave at the liker opens the conversation with the push to them", async () => {
    const ana = await person("rw-l-a")
    const dan = await person("rw-l-d")
    await db.event_likes.create({ data: { event_id: eventId, liker_id: dan.id, liked_id: ana.id } })

    expect((await received(ana)).body.data.waves.map((w: { userId: string }) => w.userId)).not.toContain(roomHandle(eventId, dan.id))
    expect((await call(waitingRoute.GET, "/api/mobile/waves", ana)).body.data.rooms).toEqual([])

    const res = await wave(ana, dan)
    expect(res.body.data.mutual).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(await matchBells(dan)).toEqual([{ body: `You and ${ana.pseudonym} both waved` }])
    expect(await matchBells(ana)).toEqual([])
  })

  it("a like from an installed build answers a wave the same way", async () => {
    const ana = await person("rw-lb-a")
    const ben = await person("rw-lb-b")
    await wave(ana, ben)
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const likes = require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route")
    const liked = await call(likes.POST, `/api/mobile/events/${eventId}/matches/likes`, ben, { method: "POST", body: { userId: roomHandle(eventId, ana.id) }, params: { eventId } })
    expect(liked.body.data.mutual).toBe(true)
  })

  it("never opens the answer-after-leaving door: a liker is waved at like anyone you were never sent a wave by", async () => {
    const ana = await person("rw-ld-a")
    const eve = await person("rw-ld-e")
    const nobodyLiked = await person("rw-ld-n")
    await db.event_likes.create({ data: { event_id: eventId, liker_id: eve.id, liked_id: ana.id } })
    await leave(ana)
    const toLiker = await wave(ana, eve)
    expect(toLiker.status).toBe(403)
    expect(await wave(ana, nobodyLiked)).toEqual(toLiker)
    expect(toLiker.body.errorCode).toBe("NOT_CHECKED_IN")
  })
})

describe("a received wave can be answered until the room closes, even after leaving (approval 10)", () => {
  it("both left: the wave back still goes, and opens the conversation", async () => {
    const ana = await person("rw-al-a")
    const ben = await person("rw-al-b")
    await wave(ana, ben)
    await leave(ana)
    await leave(ben)
    const back = await wave(ben, ana)
    expect(back.status).toBe(200)
    expect(back.body.data.mutual).toBe(true)
  })

  it("control: a NEW wave needs both inside now", async () => {
    const ana = await person("rw-nw-a")
    const ben = await person("rw-nw-b")
    await leave(ben)
    expect((await wave(ana, ben)).body.errorCode).toBe("RECIPIENT_NOT_HERE")
    expect((await wave(ben, ana)).body.errorCode).toBe("NOT_CHECKED_IN")
  })

  it("not once the room has closed, and the list is empty then", async () => {
    const host = await makeUser("rw-closed-host", "organizer")
    users.push(host)
    const closedId = await makeEvent(host)
    events.push(closedId)
    const occ = await occurrenceOf(closedId)
    const room = await db.chat_groups.create({ data: { event_id: closedId, name: "room" }, select: { id: true } })
    const [a, b] = [await person("rw-cl-a"), await person("rw-cl-b")]
    for (const p of [a, b]) {
      await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: p.id, anonymous_name: testId("Zq cl") } })
      await putInRoom({ eventId: closedId, occurrenceId: occ, userId: p.id })
    }
    expect((await wave(a, b, closedId)).status).toBe(200)
    // Ended two days ago: past the 24-hour window, the room is closed.
    const ended = { start_time: new Date(Date.now() - 3 * DAY), end_time: new Date(Date.now() - 2 * DAY) }
    await db.events.update({ where: { id: closedId }, data: ended })
    const back = await wave(b, a, closedId)
    expect(back.status).toBe(403)
    expect(back.body.errorCode).toBe("NOT_CHECKED_IN")
    const list = await call(wavesRoute.GET, `/api/mobile/events/${closedId}/waves`, b, { params: { eventId: closedId } })
    expect(list.body.data).toEqual({ open: false, total: 0, waves: [], nextCursor: null })
  })
})

describe("who the received list hides", () => {
  it("a block either way hides the wave from the recipient's list, and Banter's", async () => {
    const ana = await person("rw-b-a")
    const gus = await person("rw-b-g")
    const hal = await person("rw-b-h")
    await wave(gus, ana)
    await wave(hal, ana)
    expect((await received(ana)).body.data.total).toBe(2)
    await db.blocked_users.create({ data: { blocker_id: ana.id, blocked_id: gus.id } })
    await db.blocked_users.create({ data: { blocker_id: hal.id, blocked_id: ana.id } })
    expect((await received(ana)).body.data).toMatchObject({ total: 0, waves: [] })
    expect((await call(waitingRoute.GET, "/api/mobile/waves", ana)).body.data.rooms).toEqual([])
  })

  it("a sender the host banned, or who was suspended, is not listed; control: one who was not is", async () => {
    const ana = await person("rw-ban-a")
    const bad = await person("rw-ban-b")
    const sus = await person("rw-ban-s")
    const ok = await person("rw-ban-o")
    for (const p of [bad, sus, ok]) await wave(p, ana)
    await db.chat_group_members.updateMany({ where: { chat_group_id: groupId, user_id: bad.id }, data: { status: "banned", banned_by: users[0] } })
    await db.user.update({ where: { id: sus.id }, data: { suspended_at: new Date() } })
    const list = (await received(ana)).body.data
    expect(list.waves.map((w: { userId: string }) => w.userId)).toEqual([roomHandle(eventId, ok.id)])
  })

  it("pages 20, newest first, with the exact total", async () => {
    const ana = await person("rw-pg-a")
    const senders = await strangers(25, "rw-pg")
    const t0 = Date.now() - 60_000
    await seedWaves(senders.map((s, i) => ({ from: s, to: ana.id, at: new Date(t0 + i * 1000) })))
    const first = (await received(ana)).body.data
    expect(first.total).toBe(25)
    expect(first.waves).toHaveLength(20)
    expect(first.waves[0].userId).toBe(roomHandle(eventId, senders[24]))
    const second = (await received(ana, first.nextCursor)).body.data
    expect(second.waves).toHaveLength(5)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.waves, ...second.waves].map((w: { userId: string }) => w.userId)).size).toBe(25)
    expect((await received(ana, "not-a-cursor")).status).toBe(400)
  })

  it("Banter: one row per open room, with the waiting count and the newest", async () => {
    const ana = await person("rw-bt-a")
    const [x, y] = [await person("rw-bt-x"), await person("rw-bt-y")]
    await wave(x, ana)
    await wave(y, ana)
    const rooms = (await call(waitingRoute.GET, "/api/mobile/waves", ana)).body.data.rooms
    expect(rooms).toEqual([{ eventId, waiting: 2, latest: expect.objectContaining({ userId: roomHandle(eventId, y.id), displayName: y.pseudonym }) }])
    // Answered ones stop waiting.
    await wave(ana, y)
    expect((await call(waitingRoute.GET, "/api/mobile/waves", ana)).body.data.rooms[0]).toMatchObject({ waiting: 1 })
  })
})

describe("hosts never", () => {
  it("a host who runs the room reads no list, is never waved at, and waves at nobody", async () => {
    const org = await db.organisations.create({ data: { display_name: testId("rw-org") } })
    orgs.push(org.id)
    const hostRoom = await makeEvent(users[0])
    events.push(hostRoom)
    await db.events.update({ where: { id: hostRoom }, data: { organizer_org_id: org.id } })
    const occ = await occurrenceOf(hostRoom)
    const room = await db.chat_groups.create({ data: { event_id: hostRoom, name: "room" }, select: { id: true } })
    const [guest, host] = [await person("rw-h-g"), await person("rw-h-h")]
    await db.organisation_members.create({ data: { org_id: org.id, user_id: host.id, role: "staff" } })
    await db.user.update({ where: { id: host.id }, data: { role: "organizer" } })
    for (const p of [guest, host]) {
      await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: p.id, anonymous_name: testId("Zq h") } })
      // Checked in as a guest: membership, not the check-in's kind, makes them a host.
      await putInRoom({ eventId: hostRoom, occurrenceId: occ, userId: p.id })
    }
    expect((await wave(guest, host, hostRoom)).body.errorCode).toBe("RECIPIENT_NOT_HERE")
    expect((await wave(host, guest, hostRoom)).body.errorCode).toBe("NOT_CHECKED_IN")
    const list = await call(wavesRoute.GET, `/api/mobile/events/${hostRoom}/waves`, host, { params: { eventId: hostRoom } })
    expect(list.status).toBe(403)
    // Even a wave written straight into the table is no Banter row for a host.
    await seedWaves([{ from: guest.id, to: host.id, event: hostRoom }])
    const rooms = (await call(waitingRoute.GET, "/api/mobile/waves", host)).body.data.rooms
    expect(rooms.map((r: { eventId: string }) => r.eventId)).not.toContain(hostRoom)
  })
})

describe("the sender caps, counted from stored waves (W3-W6, W9)", () => {
  const otherRoom = async () => {
    const id = await makeEvent(users[0])
    events.push(id)
    return id
  }

  it("W3: the 20th wave in a room in an hour goes, the 21st is 429 before anything about the recipient", async () => {
    const ana = await person("rw-c3-a")
    const targets = await strangers(19, "rw-c3")
    await seedWaves(targets.map((t) => ({ from: ana.id, to: t })))
    const ben = await person("rw-c3-b")
    expect((await wave(ana, ben)).status).toBe(200)
    const capped = await wave(ana, await person("rw-c3-c"))
    expect(capped.status).toBe(429)
    expect(capped.body).toMatchObject({ errorCode: "RATE_LIMITED", retryAfter: expect.any(Number) })
    // The same answer for somebody who is nobody: the cap never looked.
    expect(await wave(ana, "rh_nobody")).toEqual(capped)
    expect(await db.event_waves.count({ where: { from_id: ana.id, event_id: eventId } })).toBe(WAVE_LIMITS.ROOM_PER_HOUR)
  })

  it("W3 control: waves older than an hour do not count toward the room's hour", async () => {
    const ana = await person("rw-c3o-a")
    const targets = await strangers(20, "rw-c3o")
    await seedWaves(targets.map((t) => ({ from: ana.id, to: t, at: new Date(Date.now() - 61 * 60_000) })))
    expect(await waveCapFor(ana.id, eventId)).toBeNull()
  })

  it("W4: 59 today in other rooms lets the 60th go; at 60 the next is refused, and logs abuse.cap_hit once", async () => {
    const ana = await person("rw-c4-a")
    const targets = await strangers(60, "rw-c4")
    const [r1, r2, r3] = [await otherRoom(), await otherRoom(), await otherRoom()]
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000)
    await seedWaves(targets.slice(0, 59).map((t, i) => ({ from: ana.id, to: t, event: [r1, r2, r3][i % 3], at: hoursAgo })))
    expect(await waveCapFor(ana.id, eventId)).toBeNull()
    await seedWaves([{ from: ana.id, to: targets[59], event: r1, at: hoursAgo }])
    const warn = jest.spyOn(logger, "warn")
    try {
      const refused = await waveCapFor(ana.id, eventId)
      expect(refused).toEqual({ cap: "day", retryAfter: expect.any(Number) })
      // About 22 hours: the oldest of the 60 ages out first.
      expect(refused!.retryAfter).toBeGreaterThan(21 * 3600)
      await waveCapFor(ana.id, eventId)
      const lines = warn.mock.calls.filter(([m]) => m === "abuse.cap_hit")
      expect(lines).toEqual([["abuse.cap_hit", { userId: ana.id, gesture: "wave", cap: WAVE_LIMITS.PER_DAY }]])
    } finally {
      warn.mockRestore()
    }
  })

  it("W5: an account under a day old gets 5 per room per hour and 15 a day; control: a month-old one does not", async () => {
    const fresh = await person("rw-c5-f", { fresh: true })
    const old = await person("rw-c5-o")
    const targets = await strangers(15, "rw-c5")
    await seedWaves(targets.slice(0, 4).flatMap((t) => [{ from: fresh.id, to: t }, { from: old.id, to: t }]))
    expect(await waveCapFor(fresh.id, eventId)).toBeNull()
    await seedWaves([{ from: fresh.id, to: targets[4] }, { from: old.id, to: targets[4] }])
    expect(await waveCapFor(fresh.id, eventId)).toMatchObject({ cap: "room_hour" })
    expect(await waveCapFor(old.id, eventId)).toBeNull()

    const room = await otherRoom()
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000)
    await seedWaves(targets.slice(5, 14).map((t) => ({ from: fresh.id, to: t, event: room, at: hoursAgo })))
    // 14 today: a new room still lets one more go...
    const another = await otherRoom()
    expect(await waveCapFor(fresh.id, another)).toBeNull()
    await seedWaves([{ from: fresh.id, to: targets[14], event: room, at: hoursAgo }])
    // ...and at 15 the day is done.
    expect(await waveCapFor(fresh.id, another)).toMatchObject({ cap: "day" })
  })

  it("W6: 20 unanswered in a day drops the room's hour to 5, and one answer lifts it", async () => {
    const ana = await person("rw-c6-a")
    const targets = await strangers(15, "rw-c6")
    const room = await otherRoom()
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000)
    await seedWaves(targets.map((t) => ({ from: ana.id, to: t, event: room, at: hoursAgo })))
    const here = await strangers(5, "rw-c6h")
    await seedWaves(here.slice(0, 4).map((t) => ({ from: ana.id, to: t })))
    // 19 unanswered: the ordinary 20 an hour.
    expect(await waveCapFor(ana.id, eventId)).toBeNull()
    await seedWaves([{ from: ana.id, to: here[4] }])
    // 20 unanswered, 5 here this hour: slowed, and at the slowed ceiling.
    expect(await waveCapFor(ana.id, eventId)).toMatchObject({ cap: "room_hour" })
    // One of the twenty waves back: 19 unanswered, the ceiling is 20 again.
    await seedWaves([{ from: targets[0], to: ana.id, event: room }])
    expect(await waveCapFor(ana.id, eventId)).toBeNull()
  })

  it("W6: a hidden like back counts as an answer too", async () => {
    const ana = await person("rw-c6l-a")
    const targets = await strangers(15, "rw-c6l")
    const room = await otherRoom()
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000)
    await seedWaves(targets.map((t) => ({ from: ana.id, to: t, event: room, at: hoursAgo })))
    await seedWaves((await strangers(5, "rw-c6lh")).map((t) => ({ from: ana.id, to: t })))
    expect(await waveCapFor(ana.id, eventId)).toMatchObject({ cap: "room_hour" })
    await db.event_likes.create({ data: { event_id: room, liker_id: targets[0], liked_id: ana.id } })
    expect(await waveCapFor(ana.id, eventId)).toBeNull()
  })
})
