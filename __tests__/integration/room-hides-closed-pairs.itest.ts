import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-closed-pairs-secret-of-32-chars!!"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { emitEventCheckIn, emitEventCheckOut, emitEventCheckOuts } from "@/lib/socket-server"
import { roomHandle } from "@/lib/room-handle"

import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/**
 * Who a viewer never sees in a room is one list (`hiddenInRooms`,
 * lib/room-people.ts): blocks either way, a pair that closed a conversation
 * (leaving is permanent), friends, and anybody the viewer reported. The deck
 * always hid all four; the roster, the participants list and the night's people
 * hid fewer, so the roster minus the deck singled out the handle of the person
 * you unmatched or reported (SCRUM-1386). Every list now agrees, its count is
 * its rows, and the live arrival and departure copies follow the same rule.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const rosterRoute = require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route")
const matchesRoute = require("@/app/api/mobile/events/[eventId]/matches/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/route")
const peopleRoute = require("@/app/api/mobile/events/[eventId]/people/route") as typeof import("@/app/api/mobile/events/[eventId]/people/route")
const wavesRoute = require("@/app/api/mobile/events/[eventId]/waves/route") as typeof import("@/app/api/mobile/events/[eventId]/waves/route")
const participantsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}

const LAT = 12.9716
const LNG = 77.5946
const users: string[] = []
const events: string[] = []

async function person(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name: label, photos: [`https://img.invalid/${label}.jpg`], show_online: true } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(handler: unknown, path: string, as: Person, params: Record<string, string>) {
  const res = await (handler as Handler)(
    new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${as.token}` } }),
    { params: Promise.resolve(params) as Promise<never> }
  )
  return { status: res.status, body: await res.json() }
}

async function liveEvent(): Promise<string> {
  const host = await makeUser(testId("rcp-host"), "organizer")
  users.push(host)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("rcp"),
      title: "Closed pairs fixture",
      description: "integration fixture",
      start_time: new Date(now - 30 * 60_000),
      end_time: new Date(now + 2 * 60 * 60_000),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: host,
      latitude: LAT,
      longitude: LNG,
      geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 },
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  return event.id
}

async function checkIn(eventId: string, p: Person) {
  const res = await (checkinRoute.POST as unknown as Handler)(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkin`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" },
      body: JSON.stringify({ latitude: LAT, longitude: LNG }),
    }),
    { params: Promise.resolve({ eventId }) as Promise<never> }
  )
  expect(res.status).toBe(200)
}

/** V and B had a conversation, and it closed: an unmatch. */
async function closePair(a: Person, b: Person) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  await db.private_conversations.create({ data: { user1_id, user2_id, closed_at: new Date() } })
}

const report = (reporter: Person, reported: Person) =>
  db.user_reports.create({ data: { reporter_id: reporter.id, reported_id: reported.id, reason: "harassment" } })

/** Each list's handles for `as`, without their own row. */
const lists = async (eventId: string, as: Person) => {
  const group = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
  const [deck, roster, people, participants] = await Promise.all([
    call(matchesRoute.GET, `/api/mobile/events/${eventId}/matches`, as, { eventId }),
    call(rosterRoute.GET, `/api/mobile/events/${eventId}/checkins`, as, { eventId }),
    call(peopleRoute.GET, `/api/mobile/events/${eventId}/people`, as, { eventId }),
    call(participantsRoute.GET, `/api/mobile/chat/groups/${group.id}/participants`, as, { chatGroupId: group.id }),
  ])
  for (const r of [deck, roster, people, participants]) expect(r.status).toBe(200)
  const own = (ids: string[]) => ids.filter((id) => id !== as.id && id !== roomHandle(eventId, as.id)).sort()
  return {
    deck: own(deck.body.data.matches.map((m: { userId: string }) => m.userId)),
    roster: own(roster.body.data.attendees.map((a: { userId: string }) => a.userId)),
    rosterTotal: roster.body.data.pagination.totalCount as number,
    rosterRows: roster.body.data.attendees.length as number,
    people: own(people.body.data.people.map((p: { userId: string }) => p.userId)),
    participants: own(participants.body.data.participants.map((p: { userId: string }) => p.userId)),
    participantsTotal: participants.body.data.totalCount as number,
    participantsRows: participants.body.data.participants.length as number,
  }
}

afterAll(async () => {
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.event_waves.deleteMany({ where: { event_id: { in: events } } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

describe("a viewer with a closed pair and a report: every room list names the same people (SCRUM-1386)", () => {
  let eventId: string
  let v: Person, b: Person, c: Person, s: Person
  const h = (p: Person) => roomHandle(eventId, p.id)

  beforeAll(async () => {
    eventId = await liveEvent()
    ;[v, b, c, s] = [await person("rcp-v"), await person("rcp-b"), await person("rcp-c"), await person("rcp-s")]
    for (const p of [v, b, c, s]) await checkIn(eventId, p)
    await closePair(v, b)
    await report(v, c)
    // Let the check-ins' background announcements finish before the lists are read.
    await new Promise((r) => setTimeout(r, 600))
  })

  it("the deck, the roster, the night's people and the participants list all list only the stranger", async () => {
    const l = await lists(eventId, v)
    expect(l.deck).toEqual([h(s)])
    expect(l.roster).toEqual(l.deck)
    expect(l.people).toEqual(l.deck)
    expect(l.participants).toEqual(l.deck)
  })

  it("leaves out the unmatched person (closed pair) on the roster and the participants list", async () => {
    const l = await lists(eventId, v)
    expect(l.roster).not.toContain(h(b))
    expect(l.participants).not.toContain(h(b))
  })

  it("leaves out the person the viewer reported on the roster, the participants list and the night's people", async () => {
    const l = await lists(eventId, v)
    expect(l.roster).not.toContain(h(c))
    expect(l.participants).not.toContain(h(c))
    expect(l.people).not.toContain(h(c))
  })

  it("counts what it lists: each total is its rows, two fewer than the room's four", async () => {
    const l = await lists(eventId, v)
    // V's own row plus the stranger's.
    expect(l.rosterTotal).toBe(2)
    expect(l.rosterTotal).toBe(l.rosterRows)
    expect(l.participantsTotal).toBe(l.participantsRows)
    expect(l.participantsTotal).toBe(2)
  })

  it("a closed pair is closed both ways; a report tells the reported person nothing", async () => {
    expect((await lists(eventId, b)).roster).not.toContain(h(v))
    const reported = await lists(eventId, c)
    expect(reported.roster).toContain(h(v))
    expect(reported.participants).toContain(h(v))
    expect(reported.deck).toContain(h(v))
  })

  it("the wave list hides their waves as the deck hides them; a stranger's wave is listed", async () => {
    await db.event_waves.createMany({ data: [b, c, s].map((p) => ({ event_id: eventId, from_id: p.id, to_id: v.id })) })
    const res = await call(wavesRoute.GET, `/api/mobile/events/${eventId}/waves`, v, { eventId })
    expect(res.status).toBe(200)
    expect(res.body.data.waves.map((w: { userId: string }) => w.userId)).toEqual([h(s)])
    expect(res.body.data.total).toBe(1)
  })

  it("reads the rows back: the pair's conversation is closed, and the report is V's", async () => {
    const [user1_id, user2_id] = conversationPair(v.id, b.id)
    const closed = await db.$queryRaw<{ closed_at: Date | null }[]>`
      SELECT closed_at FROM private_conversations WHERE user1_id = ${user1_id} AND user2_id = ${user2_id}`
    const reported = await db.$queryRaw<{ reported_id: string }[]>`
      SELECT reported_id FROM user_reports WHERE reporter_id = ${v.id}`
    expect(closed).toHaveLength(1)
    expect(closed[0].closed_at).not.toBeNull()
    expect(reported).toEqual([{ reported_id: c.id }])
    const l = await lists(eventId, v)
    // The CI log carries what the two SELECTs and the two lists returned.
    console.info(
      `[read-back] closed_at=${closed[0].closed_at?.toISOString()} reported=${reported.length === 1 && reported[0].reported_id === c.id ? "C" : "?"}` +
        ` deck=${l.deck.length} roster=${l.roster.length} total=${l.rosterTotal} same=${JSON.stringify(l.deck) === JSON.stringify(l.roster)}`
    )
  })
})

describe("arrivals and departures follow the same list: the hidden person's copy names nobody", () => {
  type Emit = { to: string; event: string; payload: Record<string, unknown> }
  const emitted: Emit[] = []
  const shared = globalThis as { __blendnSocketIo?: unknown }

  async function install(sockets: Person[], eventId: string) {
    const fake = sockets.map((p, i) => ({
      id: `sock-${i}`,
      data: { userId: p.id },
      rooms: new Set([`event:${eventId}`, `event:room:${eventId}`, `user:${p.id}`]),
      emit: (event: string, payload: Record<string, unknown>) => void emitted.push({ to: p.id, event, payload }),
      leave: () => undefined,
    }))
    const audience = (room: string, excluded: string[]) => ({
      except: (more: string[]) => audience(room, [...excluded, ...more]),
      fetchSockets: async () => fake.filter((s) => s.rooms.has(room) && !excluded.some((e) => s.rooms.has(e))),
    })
    shared.__blendnSocketIo = { in: (room: string) => audience(room, []), to: () => ({ emit: () => undefined }) }
  }
  afterEach(() => {
    emitted.length = 0
    shared.__blendnSocketIo = undefined
  })

  let eventId: string
  let v: Person, b: Person, c: Person, s: Person
  beforeAll(async () => {
    eventId = await liveEvent()
    ;[v, b, c, s] = [await person("rcp-ev"), await person("rcp-eb"), await person("rcp-ec"), await person("rcp-es")]
    for (const p of [v, b, c, s]) await checkIn(eventId, p)
    await closePair(v, b)
    await report(v, c)
    await new Promise((r) => setTimeout(r, 600))
  })

  const copies = (to: Person, event: string) => emitted.filter((e) => e.to === to.id && e.event === event)

  it.each([
    ["the unmatched person", () => b],
    ["the person the viewer reported", () => c],
  ])("an arrival of %s reaches the viewer as the bare count: no handle, no room copy", async (_, arriver) => {
    await install([v, arriver(), s], eventId)
    await emitEventCheckIn(eventId, arriver().id, "Otter", { name: "A", image: null }, true)
    expect(copies(v, "event:room:checkin")).toEqual([])
    expect(copies(v, "event:checkin")).toHaveLength(1)
    expect(copies(v, "event:checkin")[0].payload).not.toHaveProperty("userId")
    // The stranger still hears who arrived.
    expect(copies(s, "event:checkin")[0].payload.userId).toBe(roomHandle(eventId, arriver().id))
  })

  it("the reporter's own arrival still reaches the reported person with its handle (they are told nothing)", async () => {
    await install([v, c], eventId)
    await emitEventCheckIn(eventId, v.id, "Otter", { name: "V", image: null }, true)
    expect(copies(c, "event:room:checkin")).toHaveLength(1)
    expect(copies(c, "event:checkin")[0].payload.userId).toBe(roomHandle(eventId, v.id))
  })

  it("a room's departures in one pass: each leaver's copy follows that leaver's own list", async () => {
    await install([v, s], eventId)
    emitEventCheckOuts(eventId, [b.id, c.id, s.id])
    for (let i = 0; i < 40 && copies(s, "event:checkout").length < 3; i++) await new Promise((r) => setTimeout(r, 50))
    const ids = (to: Person) => copies(to, "event:checkout").map((e) => e.payload.userId ?? null)
    expect(ids(v).sort()).toEqual([null, null, roomHandle(eventId, s.id)].sort())
    expect(ids(s).sort()).toEqual([roomHandle(eventId, b.id), roomHandle(eventId, c.id), s.id].sort())
  })

  it.each([
    ["the unmatched person", () => b],
    ["the person the viewer reported", () => c],
  ])("a departure of %s reaches the viewer as the bare count", async (_, leaver) => {
    await install([v, leaver(), s], eventId)
    emitEventCheckOut(eventId, leaver().id)
    for (let i = 0; i < 40 && copies(s, "event:checkout").length < 1; i++) await new Promise((r) => setTimeout(r, 50))
    expect(copies(v, "event:checkout")).toHaveLength(1)
    expect(copies(v, "event:checkout")[0].payload).not.toHaveProperty("userId")
    expect(copies(s, "event:checkout")[0].payload.userId).toBe(roomHandle(eventId, leaver().id))
  })
})
