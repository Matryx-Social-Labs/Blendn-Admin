/*
 * "You've both been to" (SCRUM-1042, person page state 2 C): past events two people were both checked in to, listed
 * only where the other was NOT a pseudonym to the viewer there. A listed event says "this person was at X"; if they were
 * anonymous at X, the viewer who sat in that room could tie the pseudonym (and every message under it) to them.
 *
 * Real route, real rows. Each exclusion has its control beside it: the same shape with the one fact flipped is listed.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-shared-events-secret-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { conversationPair } from "@/lib/conversations"
import { flushProductEvents } from "@/lib/product-events"
import { roomHandle } from "@/lib/room-handle"
import { sharedEvents } from "@/lib/shared-events"
import { db, makeEvent, occurrenceOf, testId } from "./helpers"
import { arrive, befriend, call, cleanupCrewWorld, liveEvent, person, world, type Person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/mobile/users/[userId]/shared-events/route") as typeof import("@/app/api/mobile/users/[userId]/shared-events/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const DAY = 86_400_000
const orgs: string[] = []

let v: Person
let t: Person
let host: Person
let named: string // t revealed there
let anon: string // both there, t a pseudonym: never listed
let viaDm: string // t a pseudonym in the room, but revealed to v in the DM that room opened
let onlyT: string // v was never there
let upcoming: string // both checked in, t revealed, not over yet
let hosted: string // t revealed; host's own org ran it
let named2: string // t revealed, for host as an ordinary attendee
let roomShown: string // a live room t revealed in: its handle names them
let roomHidden: string // a live room t did not: its handle does not
const ANON_PSEUDONYM = testId("Zq Anon Heron")

/** An event that ran `daysAgo` (2 h long), with the given people checked in (and out) as attendees. */
async function past(daysAgo: number, people: string[], opts: { revealed?: string[]; org?: string } = {}) {
  const id = await makeEvent(host.id)
  world.events.push(id)
  const start = new Date(Date.now() - daysAgo * DAY)
  const times = { start_time: start, end_time: new Date(start.getTime() + 2 * 3_600_000) }
  await db.events.update({ where: { id }, data: { ...times, ...(opts.org && { organizer_org_id: opts.org }) } })
  await db.event_occurrences.updateMany({ where: { event_id: id }, data: times })
  const occurrence_id = await occurrenceOf(id)
  const group = await db.chat_groups.create({ data: { event_id: id, name: "room" }, select: { id: true } })
  for (const user_id of people) {
    await db.event_check_ins.create({
      data: { event_id: id, occurrence_id, user_id, kind: "attendee", status: "checked_out", check_in_time: start, check_out_time: times.end_time },
    })
    await db.chat_group_members.create({
      // t's pseudonym in that room: what the viewer saw there, and what the list must never tie to them.
      data: { chat_group_id: group.id, user_id, anonymous_name: user_id === t.id ? `${ANON_PSEUDONYM} ${daysAgo}` : testId("Zq Other") },
    })
  }
  for (const user_id of opts.revealed ?? []) await db.event_match_preferences.create({ data: { event_id: id, user_id, revealed: true } })
  return id
}

const list = (ref: string, as: Person, query = "") =>
  call(route.GET, `/api/mobile/users/${ref}/shared-events${query}`, as, { params: { userId: ref } })
const ids = (r: { body: { data: { events: { id: string }[] } } }) => r.body.data.events.map((e) => e.id)

beforeAll(async () => {
  v = await person("se-v", "Vee Viewer Rao")
  t = await person("se-t", "Tara Target Menon")
  host = await person("se-host", "Hari Host Nair")
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId("se-org"), status: "verified" } })
  orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: host.id, role: "owner" } })

  named = await past(10, [v.id, t.id, host.id], { revealed: [t.id] })
  anon = await past(8, [v.id, t.id, host.id])
  viaDm = await past(6, [v.id, t.id])
  onlyT = await past(4, [t.id], { revealed: [t.id] })
  hosted = await past(3, [t.id, host.id], { revealed: [t.id], org: o.id })
  named2 = await past(12, [t.id, host.id], { revealed: [t.id] })
  // Both checked in, t revealed, still running: not a past event yet.
  upcoming = await makeEvent(host.id)
  world.events.push(upcoming)
  const occ = await occurrenceOf(upcoming)
  for (const user_id of [v.id, t.id]) {
    await db.event_check_ins.create({ data: { event_id: upcoming, occurrence_id: occ, user_id, kind: "attendee", status: "checked_out", check_in_time: new Date() } })
  }
  await db.event_match_preferences.create({ data: { event_id: upcoming, user_id: t.id, revealed: true } })

  // The mutual like at viaDm opened a pseudonymous conversation, and t showed v their name in it.
  const [user1_id, user2_id] = conversationPair(v.id, t.id)
  const tIs1 = user1_id === t.id
  await db.private_conversations.create({
    data: {
      user1_id,
      user2_id,
      origin_event_id: viaDm,
      user1_pseudonym: "Zq Dm One",
      user2_pseudonym: "Zq Dm Two",
      user1_revealed: tIs1,
      user2_revealed: !tIs1,
    },
  })

  // The live rooms the page is opened from.
  const shown = await liveEvent(host.id)
  roomShown = shown.eventId
  await arrive(shown.eventId, shown.occurrenceId, t)
  await arrive(shown.eventId, shown.occurrenceId, v)
  await db.event_match_preferences.create({ data: { event_id: roomShown, user_id: t.id, revealed: true } })
  const hidden = await liveEvent(host.id)
  roomHidden = hidden.eventId
  await arrive(hidden.eventId, hidden.occurrenceId, t)
  await arrive(hidden.eventId, hidden.occurrenceId, v)
}, 60_000)

afterAll(async () => {
  // The routes record product events in a batch; write it before the pool closes, not after the suite has gone.
  await flushProductEvents()
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: world.users } }, { user2_id: { in: world.users } }] } })
  await db.event_match_preferences.deleteMany({ where: { user_id: { in: world.users } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.events.updateMany({ where: { organizer_org_id: { in: orgs } }, data: { organizer_org_id: null } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  // Last: it closes the pools.
  await cleanupCrewWorld()
})

describe("opened from a room they are named in", () => {
  it("lists the past events where they were named to you, newest first: their reveal there, or to you in that room's DM", async () => {
    const r = await list(roomHandle(roomShown, t.id), v)
    expect(r.status).toBe(200)
    expect(ids(r)).toEqual([viaDm, named])
    expect(r.body.data.pagination).toMatchObject({ totalCount: 2, hasMore: false, nextCursor: null })
    expect(r.body.data.events[1]).toMatchObject({ id: named, title: expect.any(String), startTime: expect.any(String) })
  })

  it("never lists an event they were a pseudonym at, nor one you were not at, nor one not over yet", async () => {
    const r = await list(roomHandle(roomShown, t.id), v)
    expect(ids(r)).not.toContain(anon)
    expect(ids(r)).not.toContain(onlyT)
    expect(ids(r)).not.toContain(upcoming)
    // Nor any pseudonym of theirs, from any room.
    expect(JSON.stringify(r.body)).not.toContain(ANON_PSEUDONYM)
  })
})

describe("opened through a handle that does not name them", () => {
  it("lists nothing, though they were named at past events you shared: the list would tie this pseudonym to them", async () => {
    const r = await list(roomHandle(roomHidden, t.id), v)
    expect(r.status).toBe(200)
    expect(ids(r)).toEqual([])
    expect(r.body.data.pagination.totalCount).toBe(0)
  })

  it("control: the same person by the named room's handle is listed", async () => {
    expect(ids(await list(roomHandle(roomShown, t.id), v))).toHaveLength(2)
  })
})

describe("a friend who lets friends recognise them in rooms", () => {
  afterEach(async () => {
    await db.friendships.deleteMany({ where: { OR: [{ user1_id: v.id }, { user2_id: v.id }] } })
    await db.profiles.update({ where: { id: t.id }, data: { friends_see_me_in_rooms: false } })
  })

  it("lists every past event you shared, the pseudonymous one too: their own standing consent", async () => {
    await befriend(v, t)
    await db.profiles.update({ where: { id: t.id }, data: { friends_see_me_in_rooms: true } })
    expect(ids(await list(t.id, v))).toEqual([viaDm, anon, named])
  })

  it("control: a friend with the switch off is still a pseudonym at the anonymous one", async () => {
    await befriend(v, t)
    expect(ids(await list(t.id, v))).not.toContain(anon)
  })
})

describe("never to a host", () => {
  it("never lists the event their own organisation ran, even where they could see the person", async () => {
    // host and t are friends who opted in, so t is named to host everywhere a room allows; hosted is host's own room.
    await befriend(host, t)
    await db.profiles.update({ where: { id: t.id }, data: { friends_see_me_in_rooms: true } })
    try {
      const r = ids(await list(t.id, host))
      expect(r).not.toContain(hosted)
      // control: the events host merely attended are there.
      expect(r).toEqual(expect.arrayContaining([named, anon, named2]))
    } finally {
      await db.friendships.deleteMany({ where: { OR: [{ user1_id: host.id }, { user2_id: host.id }] } })
      await db.profiles.update({ where: { id: t.id }, data: { friends_see_me_in_rooms: false } })
    }
  })

  it("the lib's own query drops the host side, whoever calls it", async () => {
    const page = await sharedEvents(host.id, t.id, { limit: 20, after: null })
    expect(page.events.map((e) => e.id)).not.toContain(hosted)
    expect(page.events.map((e) => e.id)).toEqual(expect.arrayContaining([named, named2]))
  })
})

describe("blocks and leaving hide everything", () => {
  it.each(["viewer", "target"] as const)("a block by the %s: 404, as the profile answers", async (who) => {
    const [blocker_id, blocked_id] = who === "viewer" ? [v.id, t.id] : [t.id, v.id]
    await db.blocked_users.create({ data: { blocker_id, blocked_id } })
    try {
      expect((await list(roomHandle(roomShown, t.id), v)).status).toBe(404)
      expect((await sharedEvents(v.id, t.id, { limit: 20, after: null })).events).toEqual([])
    } finally {
      await db.blocked_users.deleteMany({ where: { blocker_id, blocked_id } })
    }
  })

  it("a closed conversation between them: nothing", async () => {
    const [user1_id, user2_id] = conversationPair(v.id, t.id)
    await db.private_conversations.update({ where: { user1_id_user2_id: { user1_id, user2_id } }, data: { closed_at: new Date() } })
    try {
      expect((await sharedEvents(v.id, t.id, { limit: 20, after: null })).events).toEqual([])
    } finally {
      await db.private_conversations.update({ where: { user1_id_user2_id: { user1_id, user2_id } }, data: { closed_at: null } })
    }
  })

  it("control: the same pair, unblocked and open, is listed", async () => {
    expect((await sharedEvents(v.id, t.id, { limit: 20, after: null })).events.map((e) => e.id)).toEqual([viaDm, named])
  })
})

describe("the list itself", () => {
  it("pages newest first by its cursor, with the whole count on every page", async () => {
    const first = await list(roomHandle(roomShown, t.id), v, "?limit=1")
    expect(ids(first)).toEqual([viaDm])
    expect(first.body.data.pagination).toMatchObject({ limit: 1, hasMore: true, totalCount: 2 })
    const second = await list(roomHandle(roomShown, t.id), v, `?limit=1&cursor=${first.body.data.pagination.nextCursor}`)
    expect(ids(second)).toEqual([named])
    expect(second.body.data.pagination).toMatchObject({ hasMore: false, nextCursor: null, totalCount: 2 })
  })

  it("refuses a cursor that is not one of ours", async () => {
    expect((await list(roomHandle(roomShown, t.id), v, "?cursor=nope")).status).toBe(400)
  })

  it("is empty for yourself, and 401 without a token", async () => {
    expect(ids(await list(v.id, v))).toEqual([])
    const res = await route.GET(new (await import("next/server")).NextRequest("http://localhost/api/mobile/users/x/shared-events"), {
      params: Promise.resolve({ userId: t.id }),
    })
    expect(res.status).toBe(401)
  })
})
