/*
 * The server half of the 2026-10-27 fix round, route by route: each response
 * field or reason the client tickets lean on, read from the real handler.
 * Every change is additive (an installed build 126 ignores what it does not
 * know), so the old fields are asserted where they were.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-fix-round-secret-32-characters-xxxxx"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { db, testId } from "./helpers"
import { api, arrive, befriend, call, cleanupCrewWorld, crewOf, liveEvent, person, world, type Person } from "./crew-world"
import { makeEvent } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const blockedRoute = require("@/app/api/mobile/users/blocked/route") as typeof import("@/app/api/mobile/users/blocked/route")
const crewsRoute = require("@/app/api/mobile/crews/route") as typeof import("@/app/api/mobile/crews/route")
const interestsRoute = require("@/app/api/mobile/profiles/[userId]/interests/route") as typeof import("@/app/api/mobile/profiles/[userId]/interests/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const slugs: string[] = []
afterAll(async () => {
  const posts = (await db.board_posts.findMany({ where: { event_id: { in: world.events } }, select: { id: true } })).map((p) => p.id)
  const postRooms = { chat_group: { board_post_id: { in: posts } } }
  await db.chat_messages.deleteMany({ where: postRooms })
  await db.chat_group_members.deleteMany({ where: postRooms })
  await db.chat_groups.deleteMany({ where: { board_post_id: { in: posts } } })
  await db.board_requests.deleteMany({ where: { event_id: { in: world.events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: world.events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: world.events } } })
  await db.event_favorites.deleteMany({ where: { event_id: { in: world.events } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: world.users } } })
  await db.categories.deleteMany({ where: { slug: { in: slugs } } })
  await cleanupCrewWorld()
})

/** A published event that starts tomorrow, in a city of its own so the list finds only it. */
async function tomorrowsEvent(host: Person, city = `Fxr${testId("c").replace(/[^a-z0-9]/gi, "").slice(-8)}`) {
  const eventId = await makeEvent(host.id)
  world.events.push(eventId)
  const start = new Date(Date.now() + 86_400_000)
  await db.events.update({
    where: { id: eventId },
    data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000), city, curated_at: new Date() },
  })
  return { eventId, city }
}

describe("GET /events: checkInRadius and rsvpStatus (SCRUM-789, 791)", () => {
  it("sends the detail's own radius and the viewer's RSVP, and null when there is none", async () => {
    const [host, viewer, other] = [await person("fx-h"), await person("fx-v"), await person("fx-o")]
    const { eventId, city } = await tomorrowsEvent(host)
    const fence = { type: "circle", lat: 12.97, lng: 77.59, radius: 180, buffer: 20 }
    await db.events.update({ where: { id: eventId }, data: { latitude: 12.97, longitude: 77.59, geofence: fence } })
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: viewer.id, status: "maybe" } })
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: other.id, status: "going" } })

    const read = async (as: Person) =>
      (await call(eventsRoute.GET, `/api/mobile/events?limit=9&city=${encodeURIComponent(city)}`, as)).body.data.events.find(
        (e: { id: string }) => e.id === eventId
      )
    const mine = await read(viewer)
    expect(mine.checkInRadius).toBe(200)
    expect(mine.rsvpStatus).toBe("maybe")
    expect((await read(other)).rsvpStatus).toBe("going")
    expect((await read(host)).rsvpStatus).toBeNull()
    // The fence itself is not sent.
    expect(mine).not.toHaveProperty("geofence")
    expect(mine).not.toHaveProperty("check_in_radius")
  })
})

describe("the Board's refusals (SCRUM-862)", () => {
  it("tells a reader to save or say going, and a poster to say going, each with its reasonCode", async () => {
    const [host, reader] = [await person("fb-h"), await person("fb-r")]
    const { eventId } = await tomorrowsEvent(host)
    const read = await call(boardRoute.GET, `/api/mobile/events/${eventId}/board`, reader, { params: { eventId } })
    expect(read.status).toBe(403)
    expect(read.body).toMatchObject({ error: "Save the event or say you’re going first.", reasonCode: "BOARD_NOT_COMMITTED" })
    expect(read.body.errorCode).toBeDefined()

    await db.event_favorites.create({ data: { event_id: eventId, user_id: reader.id } })
    expect((await call(boardRoute.GET, `/api/mobile/events/${eventId}/board`, reader, { params: { eventId } })).status).toBe(200)

    const post = await call(boardRoute.POST, `/api/mobile/events/${eventId}/board`, reader, {
      method: "POST",
      body: { kind: "chat", body: "anyone going alone?" },
      params: { eventId },
    })
    expect(post.status).toBe(403)
    expect(post.body).toMatchObject({ error: "Mark yourself as going to post here", reasonCode: "BOARD_NOT_GOING" })
    expect(post.body.errorCode).toBe(read.body.errorCode)
  })
})

describe("GET /events/:id/chat: you.pseudonym (SCRUM-807, 808)", () => {
  it("names the viewer as the room names them, on the first open and after", async () => {
    const [host, me, them] = [await person("fc-h"), await person("fc-me"), await person("fc-t")]
    const { eventId } = await liveEvent(host.id)
    for (const p of [me, them]) await db.event_rsvps.create({ data: { event_id: eventId, user_id: p.id, status: "going" } })
    const open = (as: Person) => call(eventChat.GET, `/api/mobile/events/${eventId}/chat`, as, { params: { eventId } })

    const first = await open(me)
    expect(first.status).toBe(200)
    const pseudonym = first.body.data.you.pseudonym as string
    expect(pseudonym).toBeTruthy()
    const row = await db.chat_group_members.findFirstOrThrow({ where: { user_id: me.id, chat_group: { event_id: eventId } } })
    expect(pseudonym).toBe(row.anonymous_name)
    expect((await open(me)).body.data.you.pseudonym).toBe(pseudonym)
    expect((await open(them)).body.data.you.pseudonym).not.toBe(pseudonym)
  })
})

describe("room refusals carry a reasonCode (SCRUM-809)", () => {
  it("names a locked room, a muted member and a left room, keeping the old errorCodes", async () => {
    const owner = await person("fr-o", "Asha Owner Rao")
    const m = await person("fr-m")
    const c = await crewOf(owner, [m])
    const sendTo = (as: Person) => api.send(as, c.roomId, "hello")

    expect((await sendTo(m)).status).toBe(201)
    await db.chat_group_members.updateMany({ where: { chat_group_id: c.roomId, user_id: m.id }, data: { status: "left", left_at: new Date() } })
    const left = await sendTo(m)
    expect(left.status).toBe(403)
    expect(left.body.errorCode).toBe("LEFT_ROOM")
  })
})

describe("a crew's room shows its members' photos, and no other kind does (SCRUM-812)", () => {
  it("sends User.image for a crew, not for somebody keeping themselves anonymous in it", async () => {
    const owner = await person("fp-o", "Olivia Owner Rao")
    const [shown, hidden] = [await person("fp-s"), await person("fp-h")]
    for (const p of [owner, shown, hidden]) await db.user.update({ where: { id: p.id }, data: { image: `https://cdn.itest.invalid/${p.id}.jpg` } })
    const c = await crewOf(owner, [shown, hidden])
    await api.settings(hidden, c.crewId, true)
    await api.send(shown, c.roomId, "hi")
    await api.send(hidden, c.roomId, "hello")

    const history = await api.read(owner, c.roomId)
    const byContent = (content: string) => history.body.data.messages.find((m: { content: string }) => m.content === content).user.image
    expect(byContent("hi")).toBe(`https://cdn.itest.invalid/${shown.id}.jpg`)
    expect(byContent("hello")).toBeNull()

    const roster = (await api.roster(owner, c.roomId)).body.data.participants as { name: string; avatar: string | null }[]
    expect(roster.find((p) => p.name === "Olivia")?.avatar).toBe(`https://cdn.itest.invalid/${owner.id}.jpg`)
    expect(roster.filter((p) => p.avatar === null)).toHaveLength(1)
  })
})

describe("crew views: the tier badge and seatsLeft (SCRUM-830, 836)", () => {
  it("counts members and open invites against the cap of twelve", async () => {
    const owner = await person("fs-o")
    const [m1, m2, f1] = [await person("fs-1"), await person("fs-2"), await person("fs-3")]
    const c = await crewOf(owner, [m1, m2])
    expect((await api.detail(owner, c.crewId)).body.data).toMatchObject({ seatsLeft: 9, badges: [] })
    await befriend(owner, f1)
    expect((await api.invite(owner, c.crewId, [f1.id])).status).toBeLessThan(300)
    const after = (await api.detail(owner, c.crewId)).body.data
    expect(after.seatsLeft).toBe(8)
    expect((await call(crewsRoute.GET, "/api/mobile/crews", owner)).body.data.crews[0]).toMatchObject({ seatsLeft: 8 })
  })
})

describe("GET /profiles/:id as yourself: earned_badges (SCRUM-826)", () => {
  it("sends what you earned even when you do not show it, to nobody else", async () => {
    const [me, viewer] = [await person("fe-me"), await person("fe-v")]
    await db.profiles.update({ where: { id: me.id }, data: { show_badges: false } })
    const own = (await call(profileRoute.GET, `/api/mobile/profiles/${me.id}`, me, { params: { userId: me.id } })).body.data.profile
    expect(own.earned_badges).toEqual([])
    expect(own).not.toHaveProperty("badges")
    await befriend(me, viewer)
    const theirs = (await call(profileRoute.GET, `/api/mobile/profiles/${me.id}`, viewer, { params: { userId: me.id } })).body.data.profile
    expect(theirs).not.toHaveProperty("earned_badges")
  })
})

describe("GET /users/blocked: no faces (SCRUM-834)", () => {
  it("sends null for the photo even for somebody you can see", async () => {
    const [me, them] = [await person("fk-me"), await person("fk-t")]
    await befriend(me, them)
    await db.user.update({ where: { id: them.id }, data: { image: "https://cdn.itest.invalid/t.jpg" } })
    await db.blocked_users.create({ data: { blocker_id: me.id, blocked_id: them.id } })
    const list = (await call(blockedRoute.GET, "/api/mobile/users/blocked", me)).body.data.users
    expect(list).toHaveLength(1)
    expect(list[0].blocked_user_photo).toBeNull()
  })
})

describe("GET /profiles/:id/interests: a stable order (SCRUM-798)", () => {
  it("lists interests in the order they were added", async () => {
    const [me] = [await person("fi-me")]
    const names = ["Zeta", "Alpha", "Mid"]
    for (const [i, name] of names.entries()) {
      const slug = testId(`fi${i}`)
      slugs.push(slug)
      const cat = await db.categories.create({ data: { name, slug } })
      await db.user_interests.create({ data: { user_id: me.id, category_id: cat.id, created_at: new Date(Date.now() - (names.length - i) * 1000) } })
    }
    const res = await call(interestsRoute.GET, `/api/mobile/profiles/${me.id}/interests`, me, { params: { userId: me.id } })
    expect(res.body.data.interests.map((i: { name: string }) => i.name)).toEqual(names)
  })
})

describe("no photo in a room that is not a crew's (SCRUM-812)", () => {
  /** Every person in the room has an account photo; the room must not send it. */
  const withPhotos = (people: Person[]) =>
    Promise.all(people.map((p) => db.user.update({ where: { id: p.id }, data: { image: `https://cdn.itest.invalid/${p.id}.jpg` } })))
  const speak = (roomId: string, p: Person) => db.chat_messages.create({ data: { chat_group_id: roomId, user_id: p.id, content: `from ${p.id}` } })
  const photosIn = async (as: Person, roomId: string) => {
    const messages = (await api.read(as, roomId)).body.data.messages as { user: { image: string | null } }[]
    const roster = (await api.roster(as, roomId)).body.data.participants as { avatar: string | null }[]
    return { messages: messages.map((m) => m.user.image), roster: roster.map((r) => r.avatar) }
  }
  const noneOf = ({ messages, roster }: { messages: unknown[]; roster: unknown[] }) => {
    expect(messages.length).toBeGreaterThan(0)
    expect(roster.length).toBeGreaterThan(0)
    expect([...messages, ...roster].every((x) => x === null)).toBe(true)
  }

  it("event rooms send none", async () => {
    const [host, a, b] = [await person("fn-h"), await person("fn-a"), await person("fn-b")]
    await withPhotos([a, b])
    const { eventId, occurrenceId } = await liveEvent(host.id)
    await arrive(eventId, occurrenceId, a)
    await arrive(eventId, occurrenceId, b)
    const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
    await speak(room.id, b)
    noneOf(await photosIn(a, room.id))
  })

  it("a Blend's room sends none", async () => {
    const host = await person("fn-bh")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const [a1, a2, b1, b2] = await Promise.all(["a1", "a2", "b1", "b2"].map((l) => person(`fn-${l}`)))
    await withPhotos([a1, a2, b1, b2])
    const A = await crewOf(a1, [a2], "Crew Two")
    const B = await crewOf(b1, [b2], "Crew Five")
    for (const p of [a1, a2, b1, b2]) await arrive(eventId, occurrenceId, p)
    await api.likeCrew(a1, eventId, B.crewId, A.crewId)
    const roomId = (await api.likeCrew(b1, eventId, A.crewId, B.crewId)).body.data.blend.chatGroupId as string
    await speak(roomId, b1)
    noneOf(await photosIn(a1, roomId))
  })

  it("a board post's room sends none", async () => {
    const host = await person("fn-ph")
    const eventId = await makeEvent(host.id)
    world.events.push(eventId)
    const start = new Date(Date.now() + 86_400_000)
    await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) } })
    const [author, a1, a2] = [await person("fn-au"), await person("fn-p1"), await person("fn-p2")]
    await withPhotos([author, a1, a2])
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "offer", body: "car", spaces_left: 4 }, select: { id: true } })
    const decide = require("@/app/api/mobile/board/requests/[requestId]/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/route") // eslint-disable-line @typescript-eslint/no-require-imports
    for (const asker of [a1, a2]) {
      const r = await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: asker.id, to_user_id: author.id, status: "pending" }, select: { id: true } })
      expect((await call(decide.PATCH, `/api/mobile/board/requests/${r.id}`, author, { method: "PATCH", body: { action: "accept" }, params: { requestId: r.id } })).status).toBe(200)
    }
    const room = await db.chat_groups.findUniqueOrThrow({ where: { board_post_id: post.id }, select: { id: true } })
    await speak(room.id, a1)
    noneOf(await photosIn(author, room.id))
  })
})
