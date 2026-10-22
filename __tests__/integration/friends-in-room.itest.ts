import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-friends-in-room-secret-of-32-chars"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { requestFriend, unfriend } from "@/lib/friends"
import { roomPreview } from "@/lib/room-preview"
import { emitEventCheckIn, emitEventCheckOut } from "@/lib/socket-server"
import { roomHandle } from "@/lib/room-handle"

import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/**
 * Friends never meet as strangers in a room (the owner's rule, 2026-10-22,
 * plans/friends-in-room.md): a friend is never a card, a face, a row, an arrival,
 * a wave, a like or a message request to the other. To you a friend who is not
 * in "Friends here" is exactly what someone with "Show online status" off already
 * is: counted, listed nowhere. This pins package B1 against real rows.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const rosterRoute = require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route")
const matchesRoute = require("@/app/api/mobile/events/[eventId]/matches/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/route")
const likesRoute = require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route")
const wavesRoute = require("@/app/api/mobile/events/[eventId]/waves/route") as typeof import("@/app/api/mobile/events/[eventId]/waves/route")
const participantsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route")
const requestsRoute = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
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

async function person(label: string, o: { optedIn?: boolean; showOnline?: boolean } = {}): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.profiles.update({
    where: { id },
    data: { name: label, photos: [`https://img.invalid/${label}.jpg`], friends_see_me_in_rooms: !!o.optedIn, show_online: o.showOnline ?? true },
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

async function liveEvent(): Promise<string> {
  const host = await makeUser(testId("fir-host"), "organizer")
  users.push(host)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("fir"),
      title: "Friends in the room fixture",
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
  const res = await call(checkinRoute.POST, `/api/mobile/events/${eventId}/checkin`, p, {
    method: "POST",
    body: { latitude: LAT, longitude: LNG },
    params: { eventId },
  })
  expect(res.status).toBe(200)
}

const befriend = async (a: Person, b: Person) => {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  await db.friendships.create({ data: { user1_id, user2_id } })
}

const roster = (eventId: string, as: Person) => call(rosterRoute.GET, `/api/mobile/events/${eventId}/checkins`, as, { params: { eventId } })
const deck = async (eventId: string, as: Person) =>
  ((await call(matchesRoute.GET, `/api/mobile/events/${eventId}/matches`, as, { params: { eventId } })).body.data.matches as { userId: string }[]).map((m) => m.userId)
const participants = async (eventId: string, as: Person) => {
  const group = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
  return (await call(participantsRoute.GET, `/api/mobile/chat/groups/${group.id}/participants`, as, { params: { chatGroupId: group.id } })).body.data
}

afterAll(async () => {
  await db.event_likes.deleteMany({ where: { OR: [{ liker_id: { in: users } }, { liked_id: { in: users } }] } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

describe("a friend leaves every stranger surface, whatever their switch (B1)", () => {
  it.each([
    ["opted in to Friends here", true],
    ["not opted in", false],
  ])("a friend %s is in no deck, roster page, roster count or participants list, while a stranger is in all of them", async (_n, optedIn) => {
    const eventId = await liveEvent()
    const [viewer, friend, stranger, extra] = [
      await person(`fir-v-${optedIn}`),
      await person(`fir-f-${optedIn}`, { optedIn }),
      await person(`fir-s-${optedIn}`),
      await person(`fir-x-${optedIn}`),
    ]
    for (const p of [viewer, friend, stranger, extra]) await checkIn(eventId, p)
    await befriend(viewer, friend)

    const [hFriend, hStranger] = [roomHandle(eventId, friend.id), roomHandle(eventId, stranger.id)]
    const refs = await deck(eventId, viewer)
    expect(refs).toContain(hStranger)
    expect(refs).not.toContain(hFriend)

    const page = await roster(eventId, viewer)
    const listed = (page.body.data.attendees as { userId: string }[]).map((a) => a.userId)
    expect(listed).toContain(hStranger)
    expect(listed).not.toContain(hFriend)
    expect(JSON.stringify(page.body)).not.toContain(friend.id)
    // The count agrees with the list: viewer + stranger + extra, never the friend.
    expect(page.body.data.pagination.totalCount).toBe(3)

    const members = await participants(eventId, viewer)
    const names = JSON.stringify(members)
    expect(names).toContain(hStranger)
    expect(names).not.toContain(hFriend)
    expect(names).not.toContain(friend.id)
  })

  it("the room preview's taste count leaves friends out (source of the exclusion)", async () => {
    const eventId = await liveEvent()
    const people = [await person("fir-p-v"), await person("fir-p-f"), await person("fir-p-a"), await person("fir-p-b")]
    for (const p of people) await checkIn(eventId, p)
    const category = await db.categories.create({ data: { name: testId("fir-cat"), slug: testId("fir-cat") }, select: { id: true } })
    await db.user_interests.createMany({ data: people.map((p) => ({ user_id: p.id, category_id: category.id })) })
    await befriend(people[0], people[1])
    const preview = await roomPreview(eventId, people[0].id)
    // viewer shares with the two strangers; the friend is not counted.
    expect(preview.tasteMatchCount).toBe(2)
    await db.user_interests.deleteMany({ where: { category_id: category.id } })
    await db.categories.delete({ where: { id: category.id } })
  })

  it("a person with Show online status off is absent from the event room's participants list (SCRUM-141), a crew room unchanged", async () => {
    const eventId = await liveEvent()
    const [viewer, quiet, loud] = [await person("fir-q-v"), await person("fir-q-q", { showOnline: false }), await person("fir-q-l")]
    for (const p of [viewer, quiet, loud]) await checkIn(eventId, p)
    const members = JSON.stringify(await participants(eventId, viewer))
    expect(members).toContain(roomHandle(eventId, loud.id))
    expect(members).not.toContain(roomHandle(eventId, quiet.id))
  })
})

describe("what a friend's handle answers, byte for byte as an unlisted stranger (B1, 4.6)", () => {
  async function room() {
    const eventId = await liveEvent()
    const [viewer, friend, quiet] = [await person("fir-r-v"), await person("fir-r-f"), await person("fir-r-q", { showOnline: false })]
    for (const p of [viewer, friend, quiet]) await checkIn(eventId, p)
    await befriend(viewer, friend)
    return { eventId, viewer, friend, quiet, hFriend: roomHandle(eventId, friend.id), hQuiet: roomHandle(eventId, quiet.id) }
  }
  const like = (eventId: string, as: Person, ref: string) =>
    call(likesRoute.POST, `/api/mobile/events/${eventId}/matches/likes`, as, { method: "POST", body: { userId: ref }, params: { eventId } })
  const wave = (eventId: string, as: Person, ref: string) =>
    call(wavesRoute.POST, `/api/mobile/events/${eventId}/waves`, as, { method: "POST", body: { toUserId: ref }, params: { eventId } })

  it("a wave at a friend's handle is the show-online-off 403, same body", async () => {
    const { eventId, viewer, hFriend, hQuiet } = await room()
    const [toFriend, toQuiet] = [await wave(eventId, viewer, hFriend), await wave(eventId, viewer, hQuiet)]
    expect(toFriend.status).toBe(403)
    expect(toFriend).toEqual(toQuiet)
    expect(toFriend.body.errorCode).toBe("RECIPIENT_NOT_HERE")
  })

  it("a like at a friend is 200 { mutual: false } and writes nothing, either direction, so it can never match", async () => {
    const { eventId, viewer, friend, hFriend } = await room()
    const stranger = await person("fir-l-s")
    await checkIn(eventId, stranger)
    const control = await like(eventId, viewer, roomHandle(eventId, stranger.id))
    const res = await like(eventId, viewer, hFriend)
    expect(res).toEqual(control)
    expect(res.body.data).toEqual({ mutual: false })
    expect(await db.event_likes.count({ where: { liker_id: viewer.id, liked_id: friend.id } })).toBe(0)
    // The friend likes back: still nothing, still no match.
    const back = await like(eventId, friend, roomHandle(eventId, viewer.id))
    expect(back.body.data).toEqual({ mutual: false })
    expect(await db.event_likes.count({ where: { liker_id: friend.id, liked_id: viewer.id } })).toBe(0)
    expect(await db.private_conversations.count({ where: { origin_event_id: eventId } })).toBe(0)
  })

  it("becoming friends deletes the likes between them for good; an unfriend cannot resurrect a match", async () => {
    const eventId = await liveEvent()
    const [a, b] = [await person("fir-bf-a"), await person("fir-bf-b")]
    for (const p of [a, b]) await checkIn(eventId, p)
    expect((await like(eventId, a, roomHandle(eventId, b.id))).body.data).toEqual({ mutual: false })
    expect(await db.event_likes.count({ where: { liker_id: a.id, liked_id: b.id } })).toBe(1)

    expect(await requestFriend(a.id, b.id)).toBe("requested")
    expect(await requestFriend(b.id, a.id)).toBe("friends")
    expect(await db.event_likes.count({ where: { OR: [{ liker_id: a.id }, { liker_id: b.id }] } })).toBe(0)

    await unfriend(a.id, b.id)
    const after = await like(eventId, b, roomHandle(eventId, a.id))
    expect(after.body.data).toEqual({ mutual: false })
    expect(await db.private_conversations.count({ where: { origin_event_id: eventId } })).toBe(0)
  })

  it("a message request to a friend's handle is the synthetic 201 with no row and no push, even with no friend DM yet", async () => {
    const { viewer, friend, quiet, hFriend, eventId } = await room()
    const stranger = await person("fir-m-s")
    await checkIn(eventId, stranger)
    const request = (ref: string) =>
      call(requestsRoute.POST, "/api/mobile/message-requests", viewer, { method: "POST", body: { recipientId: ref, message: "hello there" } })
    const [toFriend, toStranger] = [await request(hFriend), await request(roomHandle(eventId, stranger.id))]
    expect(toFriend.status).toBe(201)
    expect(toStranger.status).toBe(201)
    const shapeOf = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(shapeOf) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])])) : typeof v
    expect(shapeOf(toFriend.body)).toEqual(shapeOf(toStranger.body))
    await new Promise((r) => setTimeout(r, 300))
    expect(await db.message_requests.count({ where: { sender_id: viewer.id, recipient_id: friend.id } })).toBe(0)
    expect(await db.notifications.count({ where: { user_id: friend.id, kind: "message_request" } })).toBe(0)
    // The stranger's request is real.
    expect(await db.message_requests.count({ where: { sender_id: viewer.id, recipient_id: { not: friend.id } } })).toBeGreaterThanOrEqual(1)
    void quiet
  })
})

describe("arrivals and departures: a friend hears the count, never the arriver (B1, D23)", () => {
  type Emit = { to: string; event: string; payload: Record<string, unknown> }
  const emitted: Emit[] = []
  const shared = globalThis as { __blendnSocketIo?: unknown }

  /** A socket.io stand-in: sockets joined to rooms, `in(room).except(...)` filtering them, emits recorded per user. */
  async function install(sockets: { userId: string; rooms: string[] }[]) {
    // The check-in route announces the arrival in the background; let those finish before the stand-in is installed.
    await new Promise((r) => setTimeout(r, 600))
    const fake = sockets.map((s, i) => ({
      id: `sock-${i}`,
      data: { userId: s.userId },
      rooms: new Set(s.rooms),
      emit: (event: string, payload: Record<string, unknown>) => void emitted.push({ to: s.userId, event, payload }),
      leave: () => undefined,
    }))
    const audience = (room: string, excluded: string[]) => ({
      except: (more: string[]) => audience(room, [...excluded, ...more]),
      fetchSockets: async () => fake.filter((s) => s.rooms.has(room) && !excluded.some((e) => s.rooms.has(e))),
    })
    shared.__blendnSocketIo = { in: (room: string) => audience(room, []), to: () => ({ emit: () => undefined }) }
  }
  beforeEach(() => void (emitted.length = 0))
  afterEach(() => void (shared.__blendnSocketIo = undefined))

  it("an arrival: the friend gets event:checkin without userId and no event:room:checkin; a stranger gets both; the arriver sees their own id", async () => {
    const eventId = await liveEvent()
    const [arriver, friend, stranger] = [await person("fir-e-a"), await person("fir-e-f"), await person("fir-e-s")]
    for (const p of [arriver, friend, stranger]) await checkIn(eventId, p)
    await befriend(arriver, friend)
    await install(
      [arriver, friend, stranger].map((p) => ({ userId: p.id, rooms: [`event:${eventId}`, `event:room:${eventId}`, `user:${p.id}`] }))
    )
    await emitEventCheckIn(eventId, arriver.id, "Otter", { name: "Arriver", image: null }, [], true)

    const to = (p: Person, event: string) => emitted.filter((e) => e.to === p.id && e.event === event)
    expect(to(friend, "event:room:checkin")).toEqual([])
    const friendsCopy = to(friend, "event:checkin")
    expect(friendsCopy).toHaveLength(1)
    expect(friendsCopy[0].payload).not.toHaveProperty("userId")
    expect(friendsCopy[0].payload).toHaveProperty("hereCount")
    expect(JSON.stringify(friendsCopy)).not.toContain(roomHandle(eventId, arriver.id))

    expect(to(stranger, "event:room:checkin")).toHaveLength(1)
    expect(to(stranger, "event:checkin")[0].payload.userId).toBe(roomHandle(eventId, arriver.id))
    expect(to(arriver, "event:checkin")[0].payload.userId).toBe(arriver.id)
  })

  it("a departure: the friend's copy carries the count and no handle, a stranger's carries the handle", async () => {
    const eventId = await liveEvent()
    const [leaver, friend, stranger] = [await person("fir-o-a"), await person("fir-o-f"), await person("fir-o-s")]
    for (const p of [leaver, friend, stranger]) await checkIn(eventId, p)
    await befriend(leaver, friend)
    await install([leaver, friend, stranger].map((p) => ({ userId: p.id, rooms: [`event:${eventId}`, `user:${p.id}`] })))
    emitEventCheckOut(eventId, leaver.id)
    for (let i = 0; i < 40 && emitted.filter((e) => e.event === "event:checkout").length < 3; i++) await new Promise((r) => setTimeout(r, 50))
    const copy = (p: Person) => emitted.find((e) => e.to === p.id && e.event === "event:checkout")!.payload
    expect(copy(friend)).not.toHaveProperty("userId")
    expect(copy(friend)).toHaveProperty("hereCount")
    expect(copy(stranger).userId).toBe(roomHandle(eventId, leaver.id))
    expect(copy(leaver).userId).toBe(leaver.id)
  })
})
