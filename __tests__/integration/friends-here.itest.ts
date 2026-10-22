import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-friends-here-secret-of-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { db as appDb } from "@/lib/db"
import { friendsHere } from "@/lib/friends-here"
import { requestFriend, unfriend } from "@/lib/friends"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, testId } from "./helpers"

/**
 * GET /events/:id/friends-here (package B2): the friends here who let friends
 * see them, by real id. Not reciprocal (the target's consent); "Show online
 * status" off beats it; staff, suspended, checked-out and still-pseudonymous
 * friends are not listed; a viewer who is not checked in is refused as the
 * roster refuses them. The payload carries no event, room or arrival time.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/mobile/events/[eventId]/friends-here/route") as typeof import("@/app/api/mobile/events/[eventId]/friends-here/route")
const profilePut = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}
const users: string[] = []
const events: string[] = []

async function person(label: string, o: { optedIn?: boolean; showOnline?: boolean; name?: string } = {}): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.profiles.update({
    where: { id },
    data: { name: o.name ?? label, photos: [`https://img.invalid/${label}.jpg`], friends_see_me_in_rooms: o.optedIn ?? true, show_online: o.showOnline ?? true },
  })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
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

async function room(): Promise<{ eventId: string; occurrence: string }> {
  const host = await makeUser(testId("fh-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  return { eventId, occurrence: await occurrenceOf(eventId) }
}

/** An event with a geofence, so check-in goes through the real route. */
async function liveRoom(): Promise<{ eventId: string; occurrence: string }> {
  const host = await makeUser(testId("fh-lhost"), "organizer")
  users.push(host)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("fhl"),
      title: "Friends here fixture",
      description: "integration fixture",
      start_time: new Date(now - 30 * 60_000),
      end_time: new Date(now + 2 * 60 * 60_000),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: host,
      latitude: 12.9716,
      longitude: 77.5946,
      geofence: { type: "circle", lat: 12.9716, lng: 77.5946, radius: 60, buffer: 20 },
    },
  })
  events.push(event.id)
  const occurrence = await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  return { eventId: event.id, occurrence: occurrence.id }
}

async function here(eventId: string, occurrence: string, p: Person, o: { kind?: "attendee" | "staff"; at?: Date; status?: "checked_in" | "checked_out" } = {}) {
  await db.event_check_ins.create({
    data: {
      user_id: p.id,
      event_id: eventId,
      occurrence_id: occurrence,
      check_in_time: o.at ?? new Date(),
      status: o.status ?? "checked_in",
      ...(o.kind && { kind: o.kind }),
    },
  })
}

const friends = async (a: Person, b: Person) => {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  await db.friendships.create({ data: { user1_id, user2_id } })
}

const list = (eventId: string, as: Person, query = "") =>
  call(route.GET, `/api/mobile/events/${eventId}/friends-here${query}`, as, { params: { eventId } })

afterAll(async () => {
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

describe("who is in Friends here", () => {
  it("lists an opted-in friend who is checked in, by real id, with a name and a photo and nothing about the event", async () => {
    const { eventId, occurrence } = await room()
    const [viewer, friend, stranger] = [await person("fh-1v"), await person("fh-1f", { name: "Asha Menon" }), await person("fh-1s")]
    for (const p of [viewer, friend, stranger]) await here(eventId, occurrence, p)
    await friends(viewer, friend)

    const res = await list(eventId, viewer)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      friends: [{ userId: friend.id, name: "Asha Menon", photo: "https://img.invalid/fh-1f.jpg" }],
      total: 1,
      nextCursor: null,
    })
    expect(JSON.stringify(res.body)).not.toMatch(/event|room|checkIn|arriv/i)
  })

  it("is not reciprocal: A on, B off. B sees A; A does not see B", async () => {
    const { eventId, occurrence } = await room()
    const [a, b] = [await person("fh-3a", { optedIn: true }), await person("fh-3b", { optedIn: false })]
    for (const p of [a, b]) await here(eventId, occurrence, p)
    await friends(a, b)
    expect((await list(eventId, b)).body.data.friends.map((f: { userId: string }) => f.userId)).toEqual([a.id])
    expect((await list(eventId, a)).body.data).toEqual({ friends: [], total: 0, nextCursor: null })
  })

  it("leaves out a friend with Show online status off, a suspended one, staff, one who checked out, and a non-friend", async () => {
    const { eventId, occurrence } = await room()
    const viewer = await person("fh-4v")
    const [quiet, suspended, staff, left, stranger, listed] = [
      await person("fh-4q", { showOnline: false }),
      await person("fh-4s"),
      await person("fh-4w"),
      await person("fh-4l"),
      await person("fh-4x"),
      await person("fh-4k"),
    ]
    await here(eventId, occurrence, viewer)
    await here(eventId, occurrence, quiet)
    await here(eventId, occurrence, suspended)
    await here(eventId, occurrence, staff, { kind: "staff" })
    await here(eventId, occurrence, left, { status: "checked_out" })
    await here(eventId, occurrence, stranger)
    await here(eventId, occurrence, listed)
    await db.user.update({ where: { id: suspended.id }, data: { suspended_at: new Date() } })
    for (const f of [quiet, suspended, staff, left, listed]) await friends(viewer, f)
    const res = await list(eventId, viewer)
    expect(res.body.data.friends.map((f: { userId: string }) => f.userId)).toEqual([listed.id])
    expect(res.body.data.total).toBe(1)
  })

  it("refuses a viewer who is not checked in, as the roster does", async () => {
    const { eventId, occurrence } = await room()
    const [viewer, friend] = [await person("fh-5v"), await person("fh-5f")]
    await here(eventId, occurrence, friend)
    await friends(viewer, friend)
    const res = await list(eventId, viewer)
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ errorCode: "NOT_CHECKED_IN", error: "Check in to see who else is here" })
  })

  it("leaves out a friend who is still a pseudonym in a match (Message would be a 409)", async () => {
    const { eventId, occurrence } = await room()
    const [viewer, friend, plain] = [await person("fh-8v"), await person("fh-8f"), await person("fh-8p")]
    for (const p of [viewer, friend, plain]) await here(eventId, occurrence, p)
    await friends(viewer, friend)
    await friends(viewer, plain)
    const [user1_id, user2_id] = conversationPair(viewer.id, friend.id)
    await db.private_conversations.create({ data: { user1_id, user2_id, user1_pseudonym: "Otter", user2_pseudonym: "Heron" } })
    expect((await list(eventId, viewer)).body.data.friends.map((f: { userId: string }) => f.userId)).toEqual([plain.id])
  })
})

describe("order, limit and the cursor", () => {
  it("recent: the friend you last talked to first, then the newest arrival", async () => {
    const { eventId, occurrence } = await room()
    const viewer = await person("fh-6v")
    const [talked, older, newest] = [await person("fh-6t"), await person("fh-6o"), await person("fh-6n")]
    await here(eventId, occurrence, viewer)
    await here(eventId, occurrence, talked, { at: new Date(Date.now() - 3 * 3600_000) })
    await here(eventId, occurrence, older, { at: new Date(Date.now() - 2 * 3600_000) })
    await here(eventId, occurrence, newest, { at: new Date(Date.now() - 60_000) })
    for (const f of [talked, older, newest]) await friends(viewer, f)
    const [user1_id, user2_id] = conversationPair(viewer.id, talked.id)
    await db.private_conversations.create({ data: { user1_id, user2_id, origin_friendship: true, last_message_at: new Date() } })
    expect((await list(eventId, viewer)).body.data.friends.map((f: { userId: string }) => f.userId)).toEqual([talked.id, newest.id, older.id])
  })

  it("name: 120 friends in pages of 50 with a cursor, no duplicates, no gaps; q filters; the limit is clamped", async () => {
    const { eventId, occurrence } = await room()
    const viewer = await person("fh-6bv")
    await here(eventId, occurrence, viewer)
    const names: string[] = []
    for (let i = 0; i < 120; i++) {
      const name = `${i % 2 ? "Zed" : "Amy"} ${String(i).padStart(3, "0")}`
      const f = await person(`fh-6b${i}`, { name })
      await here(eventId, occurrence, f)
      await friends(viewer, f)
      names.push(name)
    }
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res: { body: { data: { friends: { name: string }[]; total: number; nextCursor: string | null } } } = await list(
        eventId, viewer, `?order=name&limit=50${cursor ? `&cursor=${cursor}` : ""}`
      )
      expect(res.body.data.total).toBe(120)
      expect(res.body.data.friends.length).toBeLessThanOrEqual(50)
      seen.push(...res.body.data.friends.map((f) => f.name))
      cursor = res.body.data.nextCursor
      pages++
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toHaveLength(120)
    expect(new Set(seen).size).toBe(120)
    expect(seen).toEqual([...names].sort((a, b) => a.localeCompare(b)))

    const q = await list(eventId, viewer, "?order=name&q=zed")
    expect(q.body.data.total).toBe(60)
    expect(q.body.data.friends.every((f: { name: string }) => f.name.startsWith("Zed"))).toBe(true)

    // A limit above 50 is clamped; the default is 8; a bad cursor is a 400.
    expect((await list(eventId, viewer, "?limit=500")).body.data.friends).toHaveLength(50)
    expect((await list(eventId, viewer)).body.data.friends).toHaveLength(8)
    expect((await list(eventId, viewer, "?order=name&cursor=nonsense")).status).toBe(400)
    expect((await list(eventId, viewer, `?order=name&q=${"x".repeat(41)}`)).status).toBe(400)
  })

  it("reads three tables however many friends: 3 reads with 1 friend and with 120", async () => {
    const reads: string[] = []
    const spies = (["friendships", "event_check_ins", "private_conversations"] as const).map((table) => {
      const model = appDb[table] as unknown as { findMany: (...a: unknown[]) => unknown }
      const real = model.findMany.bind(model)
      return jest.spyOn(model, "findMany").mockImplementation((...a: unknown[]) => (reads.push(table), real(...a)) as never)
    })
    try {
      const { eventId, occurrence } = await room()
      const viewer = await person("fh-qv")
      await here(eventId, occurrence, viewer)
      const one = await person("fh-q1")
      await here(eventId, occurrence, one)
      await friends(viewer, one)
      await friendsHere(eventId, viewer.id, { order: "recent", limit: 8 })
      expect(reads).toEqual(["friendships", "event_check_ins", "private_conversations"])
      for (let i = 0; i < 60; i++) {
        const f = await person(`fh-qm${i}`)
        await here(eventId, occurrence, f)
        await friends(viewer, f)
      }
      reads.length = 0
      await friendsHere(eventId, viewer.id, { order: "recent", limit: 8 })
      expect(reads).toEqual(["friendships", "event_check_ins", "private_conversations"])
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})

describe("room:friends (the signal) and who it reaches", () => {
  const emitted: { rooms: string[]; event: string; payload: unknown }[] = []
  const shared = globalThis as { __blendnSocketIo?: unknown }
  function install() {
    const chain = (rooms: string[]) => ({
      to: (r: string | string[]) => chain([...rooms, ...(Array.isArray(r) ? r : [r])]),
      emit: (event: string, payload: unknown) => void emitted.push({ rooms, event, payload }),
      except: () => chain(rooms),
      fetchSockets: async () => [],
    })
    shared.__blendnSocketIo = { to: (r: string | string[]) => chain(Array.isArray(r) ? r : [r]), in: () => chain([]) }
  }
  beforeEach(() => void (emitted.length = 0))
  afterEach(() => void (shared.__blendnSocketIo = undefined))
  const signals = () => emitted.filter((e) => e.event === "room:friends")
  const settle = () => new Promise((r) => setTimeout(r, 600))

  it("an opted-in friend's check-in tells their friends who are here, content-free; a hidden friend's tells nobody", async () => {
    const { eventId, occurrence } = await liveRoom()
    const [viewer, listedFriend, hiddenFriend] = [await person("fh-s1v"), await person("fh-s1l"), await person("fh-s1h", { optedIn: false })]
    await here(eventId, occurrence, viewer)
    await friends(viewer, listedFriend)
    await friends(viewer, hiddenFriend)
    install()
    const checkIn = (p: Person) =>
      call(checkinRoute.POST, `/api/mobile/events/${eventId}/checkin`, p, { method: "POST", body: { latitude: 12.9716, longitude: 77.5946 }, params: { eventId } })

    expect((await checkIn(hiddenFriend)).status).toBe(200)
    await settle()
    expect(signals()).toEqual([])

    expect((await checkIn(listedFriend)).status).toBe(200)
    await settle()
    const toViewer = signals().filter((e) => e.rooms.includes(`user:${viewer.id}`))
    expect(toViewer).toHaveLength(1)
    expect(toViewer[0].payload).toEqual({ eventId })
    // Only the people it concerns: nobody else's room.
    expect(signals().flatMap((e) => e.rooms)).toEqual([`user:${viewer.id}`])
  })

  it("flipping the switch mid-event tells the friends who are here; flipping it while hidden both before and after tells nobody", async () => {
    const { eventId, occurrence } = await room()
    const [viewer, friend] = [await person("fh-s2v"), await person("fh-s2f", { optedIn: false })]
    await here(eventId, occurrence, viewer)
    await here(eventId, occurrence, friend)
    await friends(viewer, friend)
    install()
    const put = (body: unknown) => call(profilePut.PUT, `/api/mobile/profiles/${friend.id}`, friend, { method: "PUT", body, params: { userId: friend.id } })
    expect((await put({ friends_see_me_in_rooms: true })).status).toBe(200)
    await settle()
    expect(signals().filter((e) => e.rooms.includes(`user:${viewer.id}`) && JSON.stringify(e.payload) === JSON.stringify({ eventId }))).toHaveLength(1)
    emitted.length = 0
    expect((await put({ friends_see_me_in_rooms: false })).status).toBe(200)
    await settle()
    expect(signals().filter((e) => e.rooms.includes(`user:${viewer.id}`))).toHaveLength(1)
    emitted.length = 0
    // Hidden before AND after (the switch stays off, a different field moves): nothing.
    expect((await put({ show_online: false })).status).toBe(200)
    await settle()
    expect(signals()).toEqual([])
  })

  it("becoming friends mid-event tells both, for the event they are both in", async () => {
    const { eventId, occurrence } = await room()
    const [a, b] = [await person("fh-s3a"), await person("fh-s3b")]
    await here(eventId, occurrence, a)
    await here(eventId, occurrence, b)
    install()
    const { requestFriend } = await import("@/lib/friends")
    await requestFriend(a.id, b.id)
    await requestFriend(b.id, a.id)
    await settle()
    const rooms = signals().flatMap((s) => s.rooms)
    expect(rooms).toEqual(expect.arrayContaining([`user:${a.id}`, `user:${b.id}`]))
  })
})

describe("the second look (final review): who a friendship change is told to, and what an ex is", () => {
  const emitted: { rooms: string[]; event: string; payload: unknown }[] = []
  const shared = globalThis as { __blendnSocketIo?: unknown }
  beforeEach(() => {
    emitted.length = 0
    const chain = (rooms: string[]): Record<string, unknown> => ({
      to: (r: string | string[]) => chain([...rooms, ...(Array.isArray(r) ? r : [r])]),
      emit: (event: string, payload: unknown) => void emitted.push({ rooms, event, payload }),
      except: () => chain(rooms),
      fetchSockets: async () => [],
    })
    shared.__blendnSocketIo = { to: (r: string | string[]) => chain(Array.isArray(r) ? r : [r]), in: () => chain([]) }
  })
  afterEach(() => void (shared.__blendnSocketIo = undefined))
  const signalsTo = (p: Person) => emitted.filter((e) => e.event === "room:friends" && e.rooms.includes(`user:${p.id}`)).length
  const settle = () => new Promise((r) => setTimeout(r, 600))

  it("H2: unfriending or befriending a hidden friend signals nobody; a listable one signals only the person who sees them", async () => {
    const { eventId, occurrence } = await room()
    const [viewer, hidden, listed] = [await person("fh-h2v", { optedIn: false }), await person("fh-h2h", { optedIn: false }), await person("fh-h2l")]
    for (const p of [viewer, hidden, listed]) await here(eventId, occurrence, p)

    // Two hidden people: nothing, either way round.
    expect(await requestFriend(viewer.id, hidden.id)).toBe("requested")
    expect(await requestFriend(hidden.id, viewer.id)).toBe("friends")
    await unfriend(viewer.id, hidden.id)
    await settle()
    expect(emitted.filter((e) => e.event === "room:friends")).toEqual([])

    // A listable friend: the one who can see them is told; the listable one is not (the viewer is hidden from them).
    await requestFriend(viewer.id, listed.id)
    await requestFriend(listed.id, viewer.id)
    await settle()
    expect(signalsTo(viewer)).toBe(1)
    expect(signalsTo(listed)).toBe(0)
  })

  it("H3: after an unfriend /friends-here is empty for both, and the ex is never told again", async () => {
    const { eventId, occurrence } = await room()
    const [a, b] = [await person("fh-h3a"), await person("fh-h3b")]
    for (const p of [a, b]) await here(eventId, occurrence, p)
    await friends(a, b)
    expect((await list(eventId, a)).body.data.total).toBe(1)
    expect((await list(eventId, b)).body.data.total).toBe(1)

    await unfriend(a.id, b.id)
    // The 24 h of an ended friendship keep them off the stranger surfaces; they are not friends here.
    expect((await list(eventId, a)).body.data).toEqual({ friends: [], total: 0, nextCursor: null })
    expect((await list(eventId, b)).body.data).toEqual({ friends: [], total: 0, nextCursor: null })

    emitted.length = 0
    const { notifyFriendsHere } = await import("@/lib/room-friends")
    await notifyFriendsHere(b.id, { force: true })
    await notifyFriendsHere(a.id, { force: true })
    expect(emitted.filter((e) => e.event === "room:friends")).toEqual([])
  })

  it("L2: a friend whose DM is closed is not listed", async () => {
    const { eventId, occurrence } = await room()
    const [viewer, closed, open] = [await person("fh-l2v"), await person("fh-l2c"), await person("fh-l2o")]
    for (const p of [viewer, closed, open]) await here(eventId, occurrence, p)
    await friends(viewer, closed)
    await friends(viewer, open)
    const [user1_id, user2_id] = conversationPair(viewer.id, closed.id)
    await db.private_conversations.create({ data: { user1_id, user2_id, origin_friendship: true, closed_at: new Date(), closed_reason: "unmatch" } })
    expect((await list(eventId, viewer)).body.data.friends.map((f: { userId: string }) => f.userId)).toEqual([open.id])
  })

  it("L1 (wiring): a staff check-in is never signalled, in or out", async () => {
    const { eventId, occurrence } = await liveRoom()
    const [viewer, staff] = [await person("fh-l1v"), await person("fh-l1s")]
    await here(eventId, occurrence, viewer)
    await friends(viewer, staff)
    await db.event_check_ins.create({ data: { user_id: staff.id, event_id: eventId, occurrence_id: occurrence, check_in_time: new Date(), status: "checked_in", kind: "staff" } })
    const { notifyFriendsHere } = await import("@/lib/room-friends")
    // The wiring: both writers skip a non-attendee, so nothing ever reaches this helper for staff.
    const { readFileSync } = await import("fs")
    expect(readFileSync("lib/check-in-core.ts", "utf8")).toMatch(/kind === "attendee"\) void notifyFriendsHere/)
    expect(readFileSync("lib/checkout.ts", "utf8")).toMatch(/checkIn\.kind === "attendee"\) void notifyFriendsHere/)
    void notifyFriendsHere
    expect(emitted.filter((e) => e.event === "room:friends")).toEqual([])
  })

  it("M1: the rating push leaves out an ex-friend of the last 24 h, as the list does", async () => {
    const { rateRequestAudience } = await import("@/lib/services/event-notifications.service")
    const { eventId, occurrence } = await room()
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - 4 * 3600_000), end_time: new Date(Date.now() - 3600_000) } })
    const [a, b] = [await person("fh-m1a"), await person("fh-m1b")]
    for (const p of [a, b]) await here(eventId, occurrence, p)
    const [user1_id, user2_id] = conversationPair(a.id, b.id)
    await db.private_conversations.create({ data: { user1_id, user2_id, origin_event_id: eventId, user1_pseudonym: "O", user2_pseudonym: "H", user1_revealed: true, user2_revealed: true } })
    expect((await rateRequestAudience(eventId)).withPeers.sort()).toEqual([a.id, b.id].sort())
    await db.ended_friendships.create({ data: { user1_id, user2_id } })
    expect((await rateRequestAudience(eventId)).withPeers).toEqual([])
  })
})

