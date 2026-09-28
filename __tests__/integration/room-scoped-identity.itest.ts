import { NextRequest } from "next/server"

/*
 * A room handle is answered in its own room's terms.
 *
 * Reproduced on staging, 2026-09-28, at blr-design-festival: an attendee had
 * revealed at two events the viewer also checked into (A, B), liked the viewer
 * at A without it being returned, and stayed anonymous at the festival (C). C's
 * roster showed her pseudonym. "View profile" on that card sent C's handle to
 * `GET /users/:ref`, the gate asked "may the viewer know who she is anywhere",
 * A said yes, and the response carried her real name, photos, bio and city —
 * linking the pseudonym she kept at C to her.
 *
 * This builds exactly that world through the real check-in route and reads it
 * back through the routes a card can reach, so the roster and the profile are
 * compared as a client would see them.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-room-scoped-identity-secret-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { resolveUserRef, roomHandle } from "@/lib/room-handle"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const rosterRoute = require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route")
const userRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const interestsRoute = require("@/app/api/mobile/profiles/[userId]/interests/route") as typeof import("@/app/api/mobile/profiles/[userId]/interests/route")
const requestsRoute = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
const friendRequestsRoute = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const friendRoute = require("@/app/api/mobile/friends/[userId]/route") as typeof import("@/app/api/mobile/friends/[userId]/route")
const matchesRoute = require("@/app/api/mobile/events/[eventId]/matches/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}

const LAT = 12.9716
const LNG = 77.5946
const REAL_NAME = "Tanvi Fixture Kulkarni"
const PHOTO = "https://cdn.itest.invalid/tanvi-1.jpg"
const BLUR = "https://cdn.itest.invalid/tanvi-blur.jpg"
const BIO = "Type designer, Indiranagar regular"
const users: string[] = []
const events: string[] = []
const categorySlugs: string[] = []

async function person(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(
  handler: unknown,
  path: string,
  as: Person,
  opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}
) {
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
  const host = await makeUser(testId("rsi-host"), "organizer")
  users.push(host)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("rsi"),
      title: "Room-scoped identity fixture",
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
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
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

const reveal = (eventId: string, userId: string) =>
  db.event_match_preferences.update({
    where: { event_id_user_id: { event_id: eventId, user_id: userId } },
    data: { revealed: true },
  })

const roster = async (eventId: string, as: Person) =>
  (await call(rosterRoute.GET, `/api/mobile/events/${eventId}/checkins`, as, { params: { eventId } })).body.data
    .attendees as { userId: string; name: string; image?: string | null }[]

async function rosterRow(eventId: string, as: Person, whom: Person) {
  const row = (await roster(eventId, as)).find((a) => resolveUserRef(a.userId)?.userId === whom.id)
  if (!row) throw new Error("not on the roster")
  return row
}

const card = (ref: string, as: Person) => call(userRoute.GET, `/api/mobile/users/${ref}`, as, { params: { userId: ref } })
const profile = (ref: string, as: Person) =>
  call(profileRoute.GET, `/api/mobile/profiles/${ref}`, as, { params: { userId: ref } })
const interests = (ref: string, as: Person) =>
  call(interestsRoute.GET, `/api/mobile/profiles/${ref}/interests`, as, { params: { userId: ref } })

/** Key structure with every leaf reduced to its type, so ids and times drop out. */
const shapeOf = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(shapeOf)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]))
      : typeof v

afterAll(async () => {
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await db.categories.deleteMany({ where: { slug: { in: categorySlugs } } })
  await db.event_likes.deleteMany({ where: { event_id: { in: events } } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

describe("revealed at A and B, anonymous at C, the viewer at all three", () => {
  let A: string, B: string, C: string
  let viewer: Person, tanvi: Person, stranger: Person
  let hA: string, hC: string, hStrangerC: string
  let pseudonymAtC: string
  const seen = new Map<string, { userId: string; name: string; image?: string | null }>()

  beforeAll(async () => {
    ;[A, B, C] = [await liveEvent(), await liveEvent(), await liveEvent()]
    ;[viewer, tanvi, stranger] = [await person("rsi-viewer"), await person("rsi-tanvi"), await person("rsi-stranger")]
    await db.user.update({ where: { id: tanvi.id }, data: { name: REAL_NAME, image: PHOTO } })
    await db.profiles.update({
      where: { id: tanvi.id },
      data: {
        name: REAL_NAME,
        photos: [PHOTO],
        blur_photo: BLUR,
        bio: BIO,
        occupation: "Type designer at Fixture Foundry",
        education: "NID",
        age: 22,
        location: "Indiranagar, Bengaluru",
        work_field: "design",
      },
    })
    const slug = testId("rsi-cat")
    categorySlugs.push(slug)
    const category = await db.categories.create({ data: { name: "Letterpress", slug } })
    await db.user_interests.create({ data: { user_id: tanvi.id, category_id: category.id } })

    /*
     * One evening after another, as it happened: checking in somewhere checks
     * you out of the last place, and the roster lists who is here now. So each
     * room's card is read while both are in it — what the viewer saw there.
     */
    for (const e of [A, B, C]) {
      for (const p of [viewer, tanvi]) await checkIn(e, p)
      if (e !== C) await reveal(e, tanvi.id)
      if (e === C) await checkIn(C, stranger)
      seen.set(e, await rosterRow(e, viewer, tanvi))
    }
    // One-way: she liked the viewer at A.
    await db.event_likes.create({ data: { event_id: A, liker_id: tanvi.id, liked_id: viewer.id } })

    hA = seen.get(A)!.userId
    hC = seen.get(C)!.userId
    pseudonymAtC = seen.get(C)!.name
    hStrangerC = (await rosterRow(C, viewer, stranger)).userId
  })

  it("the roster: named with a photo at A, a pseudonym without one at C", async () => {
    expect(seen.get(A)).toMatchObject({ name: REAL_NAME, image: PHOTO })
    expect(seen.get(C)!.name).not.toBe(REAL_NAME)
    expect(seen.get(C)).not.toHaveProperty("image")
  })

  it("the profile by C's handle is the card C shows: her pseudonym, age and city, nothing else", async () => {
    const res = await card(hC, viewer)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      id: hC,
      name: pseudonymAtC,
      age: 22,
      location: expect.any(String),
      isOwnProfile: false,
      identityVisible: false,
    })
    const wire = JSON.stringify(res.body)
    for (const secret of [REAL_NAME, PHOTO, BLUR, BIO, tanvi.id, "Letterpress"]) expect(wire).not.toContain(secret)
  })

  it("so does /profiles by C's handle, the screen's fallback", async () => {
    const res = await profile(hC, viewer)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      id: hC,
      name: pseudonymAtC,
      profile: { id: hC, age: 22, onboarded: true, location: expect.any(String) },
    })
    const wire = JSON.stringify(res.body)
    for (const secret of [REAL_NAME, PHOTO, BLUR, BIO, tanvi.id, "Letterpress", "design"]) expect(wire).not.toContain(secret)
  })

  it("and the interest list by C's handle is withheld", async () => {
    expect(await interests(hC, viewer)).toEqual({ status: 200, body: expect.objectContaining({ data: { interests: [] } }) })
  })

  it("by A's handle she is who A's roster says she is", async () => {
    const res = await card(hA, viewer)
    expect(res.body.data).toMatchObject({ id: hA, name: REAL_NAME, photos: [PHOTO], bio: BIO, identityVisible: true })
    expect((await profile(hA, viewer)).body.data).toMatchObject({ name: REAL_NAME, profile: { photos: [PHOTO], bio: BIO } })
    const list = (await interests(hA, viewer)).body.data.interests as { name: string }[]
    expect(list.map((i) => i.name)).toEqual(["Letterpress"])
  })

  it("by her raw id, the unscoped answer is unchanged", async () => {
    const res = await card(tanvi.id, viewer)
    expect(res.body.data).toMatchObject({ id: tanvi.id, name: REAL_NAME, identityVisible: true })
    expect(res.body.data).toHaveProperty("memberSince")
    expect(res.body.data).toHaveProperty("stats")
  })

  it("the card and the profile agree in every room", async () => {
    for (const e of [A, B, C]) {
      const row = seen.get(e)!
      const res = await card(row.userId, viewer)
      expect({ room: e, identified: res.body.data.identityVisible, name: res.body.data.name }).toEqual({
        room: e,
        identified: row.name === REAL_NAME,
        name: row.name,
      })
    }
  })

  it("a message request by C's handle answers as one to a stranger's, even with one already pending", async () => {
    /*
     * The oracle: a request to someone already asked is a 409 for a person
     * the viewer can identify and a synthetic 201 for anyone else. Asked
     * unscoped, C's pseudonym got the 409 — which said it was her.
     */
    await db.message_requests.create({
      data: { sender_id: viewer.id, recipient_id: tanvi.id, message: "we met at A", status: "pending" },
    })
    await db.message_requests.create({
      data: { sender_id: viewer.id, recipient_id: stranger.id, message: "hello", status: "pending" },
    })
    const ask = (ref: string) =>
      call(requestsRoute.POST, "/api/mobile/message-requests", viewer, {
        method: "POST",
        body: { recipientId: ref, message: "hi" },
      })
    const [toHer, toStranger] = [await ask(hC), await ask(hStrangerC)]
    expect([toHer.status, toStranger.status]).toEqual([201, 201])
    expect(shapeOf(toHer.body)).toEqual(shapeOf(toStranger.body))
    expect(JSON.stringify(toHer.body)).not.toContain(tanvi.id)
    expect(await db.message_requests.count({ where: { sender_id: viewer.id, recipient_id: tanvi.id } })).toBe(1)
    // The control: by A's handle she is someone the viewer knows, and the
    // refusal is the honest one.
    expect((await ask(hA)).status).toBe(409)
  })

  it("a friend request by C's handle is refused as a stranger's; by A's it is not", async () => {
    const ask = (ref: string) =>
      call(friendRequestsRoute.POST, "/api/mobile/friends/requests", viewer, { method: "POST", body: { userId: ref } })
    const [toHer, toStranger] = [await ask(hC), await ask(hStrangerC)]
    expect(toHer).toEqual(toStranger)
    expect(toHer.status).toBe(404)
    expect((await ask(hA)).status).toBe(200)
  })

  it("once friends, A's handle opens the friend route and C's does not", async () => {
    // Friendship without `friends_see_me_in_rooms` is not recognition; the
    // reveal at A is, but only at A.
    const [user1_id, user2_id] = [viewer.id, tanvi.id].sort()
    await db.friendships.create({ data: { user1_id, user2_id } })
    const get = (ref: string) => call(friendRoute.GET, `/api/mobile/friends/${ref}`, viewer, { params: { userId: ref } })
    expect((await get(hC)).status).toBe(404)
    expect((await get(hA)).status).toBe(200)
  })

  it("and as a friend she stays in C's deck, as the stranger C shows", async () => {
    /*
     * The deck drops friends the viewer can recognise. Asked unscoped, the
     * reveal at A made her recognisable at C, so she alone left C's deck —
     * "on the roster, not in the deck" picked out which pseudonym was the
     * friend. Asked in C's terms she is a stranger there, and stays.
     */
    const deck = await call(matchesRoute.GET, `/api/mobile/events/${C}/matches`, viewer, { params: { eventId: C } })
    expect(deck.status).toBe(200)
    expect((deck.body.data.matches as { userId: string }[]).map((m) => m.userId)).toEqual(
      expect.arrayContaining([hC, hStrangerC])
    )
  })

  it("a handle for a room the viewer was never in names nobody, revealed or not", async () => {
    const outsider = await person("rsi-outsider")
    const ref = roomHandle(A, tanvi.id)
    const res = await card(ref, outsider)
    expect(res.body.data.identityVisible).toBe(false)
    expect(JSON.stringify(res.body)).not.toContain(REAL_NAME)
  })
})
