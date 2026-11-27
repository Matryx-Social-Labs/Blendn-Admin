/*
 * Nobody starts contact with an account that cannot take part (SCRUM-1479):
 * deleted, suspended, or stamped as known to be under 18. Each route that
 * starts contact asks `REACHABLE` (lib/room-people.ts) inside its own lookup
 * of the other person, so a stamped account answers exactly as an id nobody
 * has — the same status and body — and no row is written. An ordinary adult
 * in the same place is the control: the same call succeeds.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { randomUUID } from "crypto"

import { conversationPair } from "@/lib/conversations"
import { connectablePairs, inviteTokenFor } from "@/lib/friends"
import { roomHandle } from "@/lib/room-handle"

import { arrive, befriend, call, cleanupCrewWorld, crewOf, liveEvent, person, routes, world, type Person, api } from "./crew-world"
import { db, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const conversationsRoute = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")
const requestsRoute = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
const respondRoute = require("@/app/api/mobile/message-requests/[requestId]/respond/route") as typeof import("@/app/api/mobile/message-requests/[requestId]/respond/route")
const friendRequestsRoute = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const askRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route")
const decideRoute = require("@/app/api/mobile/board/requests/[requestId]/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/route")
const friendDmRoute = require("@/app/api/mobile/friends/[userId]/conversation/route") as typeof import("@/app/api/mobile/friends/[userId]/conversation/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const categories: string[] = []

afterAll(async () => {
  const users = world.users
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await db.categories.deleteMany({ where: { id: { in: categories } } })
  await db.board_requests.deleteMany({ where: { event_id: { in: world.events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: world.events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: world.events } } })
  await db.event_waves.deleteMany({ where: { OR: [{ from_id: { in: users } }, { to_id: { in: users } }] } })
  await db.event_likes.deleteMany({ where: { OR: [{ liker_id: { in: users } }, { liked_id: { in: users } }] } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.friend_invites.deleteMany({ where: { user_id: { in: users } } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanupCrewWorld()
})

/** Stamped as known to be under 18, as scripts/under-18-accounts.ts --apply writes it. */
const stamp = (p: Person) => db.profiles.update({ where: { id: p.id }, data: { under_18_since: new Date() } })

/** Three people: who asks, an ordinary adult (the control), and one about to be stamped. */
async function trio(label: string) {
  const [viewer, adult, minor] = [await person(`${label}-v`), await person(`${label}-a`), await person(`${label}-m`)]
  return { viewer, adult, minor }
}

describe("a stamped account answers as an unknown id, and nothing is written", () => {
  it("POST /conversations", async () => {
    const { viewer, adult, minor } = await trio("cu-conv")
    for (const other of [adult, minor]) {
      await db.message_requests.create({ data: { sender_id: viewer.id, recipient_id: other.id, status: "accepted", message: "hi" } })
    }
    await stamp(minor)
    const open = (otherUserId: string) =>
      call(conversationsRoute.POST, "/api/mobile/conversations", viewer, { method: "POST", body: { otherUserId } })

    expect((await open(adult.id)).status).toBe(200)
    const [toMinor, toNobody] = [await open(minor.id), await open(randomUUID())]
    expect(toMinor.status).toBe(404)
    expect(toMinor).toEqual(toNobody)
    const [user1_id, user2_id] = conversationPair(viewer.id, minor.id)
    expect(await db.private_conversations.count({ where: { user1_id, user2_id } })).toBe(0)
  })

  it("POST /message-requests", async () => {
    const { viewer, adult, minor } = await trio("cu-mr")
    const host = await makeUser(testId("cu-mr-host"), "organizer")
    world.users.push(host)
    const { eventId, occurrenceId } = await liveEvent(host)
    for (const p of [viewer, adult, minor]) await arrive(eventId, occurrenceId, p)
    await stamp(minor)
    const ask = (ref: string) =>
      call(requestsRoute.POST, "/api/mobile/message-requests", viewer, { method: "POST", body: { recipientId: ref, message: "hello there" } })

    expect((await ask(roomHandle(eventId, adult.id))).status).toBe(201)
    const [toMinor, toNobody] = [await ask(roomHandle(eventId, minor.id)), await ask(roomHandle(eventId, randomUUID()))]
    expect(toMinor.status).toBe(404)
    expect(toMinor).toEqual(toNobody)
    expect(await db.message_requests.count({ where: { sender_id: viewer.id, recipient_id: minor.id } })).toBe(0)
  })

  it("accepting a message request a stamped account sent", async () => {
    const { viewer, adult, minor } = await trio("cu-acc")
    const fromAdult = await db.message_requests.create({ data: { sender_id: adult.id, recipient_id: viewer.id, message: "hi" } })
    const fromMinor = await db.message_requests.create({ data: { sender_id: minor.id, recipient_id: viewer.id, message: "hi" } })
    await stamp(minor)
    const accept = (requestId: string) =>
      call(respondRoute.POST, `/api/mobile/message-requests/${requestId}/respond`, viewer, {
        method: "POST",
        body: { action: "accept" },
        params: { requestId },
      })

    expect((await accept(fromAdult.id)).status).toBe(200)
    const [ofMinor, ofNobody] = [await accept(fromMinor.id), await accept(randomUUID())]
    expect(ofMinor.status).toBe(404)
    expect(ofMinor).toEqual(ofNobody)
    expect((await db.message_requests.findUniqueOrThrow({ where: { id: fromMinor.id } })).status).toBe("pending")
    const [user1_id, user2_id] = conversationPair(viewer.id, minor.id)
    expect(await db.private_conversations.count({ where: { user1_id, user2_id } })).toBe(0)
  })

  it("a friend request through the person's invite link", async () => {
    const { viewer, adult, minor } = await trio("cu-fr")
    const [adultToken, minorToken] = [await inviteTokenFor(adult.id), await inviteTokenFor(minor.id)]
    await stamp(minor)
    const ask = (token: string) => call(friendRequestsRoute.POST, "/api/mobile/friends/requests", viewer, { method: "POST", body: { token } })

    expect((await ask(adultToken)).status).toBe(200)
    const [toMinor, toNobody] = [await ask(minorToken), await ask(`${minorToken.slice(0, -4)}zzzz`)]
    expect(toMinor.status).toBe(404)
    expect(toMinor).toEqual(toNobody)
    expect(await db.friend_requests.count({ where: { sender_id: viewer.id, recipient_id: minor.id } })).toBe(0)
    // The batched form (a release of held requests) says the same.
    const pairs = await connectablePairs(db, [[viewer.id, adult.id], [viewer.id, minor.id]])
    expect([...pairs]).toEqual([conversationPair(viewer.id, adult.id).join("|")])
  })

  it("opening a DM with a friend", async () => {
    const { viewer, adult, minor } = await trio("cu-fdm")
    await befriend(viewer, adult, minor)
    await stamp(minor)
    const openDm = (userId: string) =>
      call(friendDmRoute.POST, `/api/mobile/friends/${userId}/conversation`, viewer, { method: "POST", params: { userId } })

    expect((await openDm(adult.id)).status).toBe(200)
    const [toMinor, toNobody] = [await openDm(minor.id), await openDm(randomUUID())]
    expect(toMinor.status).toBe(404)
    expect(toMinor).toEqual(toNobody)
    const [user1_id, user2_id] = conversationPair(viewer.id, minor.id)
    expect(await db.private_conversations.count({ where: { user1_id, user2_id } })).toBe(0)
  })

  it("a wave and a like in the room", async () => {
    const { viewer, adult, minor } = await trio("cu-wl")
    const host = await makeUser(testId("cu-wl-host"), "organizer")
    world.users.push(host)
    const { eventId, occurrenceId } = await liveEvent(host)
    for (const p of [viewer, adult, minor]) await arrive(eventId, occurrenceId, p)
    await stamp(minor)
    const wave = (ref: string) => call(routes.waves.POST, `/api/mobile/events/${eventId}/waves`, viewer, { method: "POST", body: { toUserId: ref }, params: { eventId } })
    const like = (ref: string) =>
      call(routes.personLike.POST, `/api/mobile/events/${eventId}/matches/likes`, viewer, { method: "POST", body: { userId: ref }, params: { eventId } })
    const nobody = roomHandle(eventId, randomUUID())

    expect((await wave(roomHandle(eventId, adult.id))).status).toBe(200)
    expect((await like(roomHandle(eventId, adult.id))).status).toBe(200)
    const [waveMinor, waveNobody] = [await wave(roomHandle(eventId, minor.id)), await wave(nobody)]
    expect(waveMinor.status).toBe(403)
    expect(waveMinor).toEqual(waveNobody)
    const [likeMinor, likeNobody] = [await like(roomHandle(eventId, minor.id)), await like(nobody)]
    expect(likeMinor.status).toBe(404)
    expect(likeMinor).toEqual(likeNobody)
    expect(await db.event_waves.count({ where: { from_id: viewer.id, to_id: minor.id } })).toBe(0)
    expect(await db.event_likes.count({ where: { liker_id: viewer.id, liked_id: minor.id } })).toBe(0)
  })

  it("a crew invite", async () => {
    const { viewer, adult, minor } = await trio("cu-crew")
    const { crewId } = await crewOf(viewer, [])
    await befriend(viewer, adult, minor)
    await stamp(minor)

    expect((await api.invite(viewer, crewId, [adult.id])).status).toBe(200)
    const [toMinor, toNobody] = [await api.invite(viewer, crewId, [minor.id]), await api.invite(viewer, crewId, [randomUUID()])]
    expect(toMinor.status).toBe(404)
    expect(toMinor).toEqual(toNobody)
    expect(await db.crew_invites.count({ where: { crew_id: crewId, invited_user_id: minor.id } })).toBe(0)
  })

  it("asking a Lobby post's author, and accepting a stamped account's ask", async () => {
    const { viewer, adult, minor } = await trio("cu-lobby")
    const host = await makeUser(testId("cu-lobby-host"), "organizer")
    world.users.push(host)
    const { eventId } = await liveEvent(host)
    // Doors tomorrow: the Lobby is open.
    const start = new Date(Date.now() + 24 * 3600_000)
    await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3600_000) } })
    await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3600_000) } })
    for (const p of [viewer, adult, minor]) await db.event_rsvps.create({ data: { event_id: eventId, user_id: p.id, status: "going" } })
    // What the Lobby asks of whoever asks: two interests and why they go out.
    for (const slug of [testId("cu-int-a"), testId("cu-int-b")]) {
      const { id } = await db.categories.create({ data: { name: slug, slug }, select: { id: true } })
      categories.push(id)
      await db.user_interests.create({ data: { user_id: viewer.id, category_id: id } })
    }
    await db.profiles.update({ where: { id: viewer.id }, data: { intent_default: ["friendship"] } })
    const postBy = async (author: Person) =>
      (await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "offer", body: testId("ride"), spaces_left: 3 } })).id
    const [adultPost, minorPost, viewerPost] = [await postBy(adult), await postBy(minor), await postBy(viewer)]
    const askedBy = async (asker: Person) =>
      (await db.board_requests.create({ data: { post_id: viewerPost, event_id: eventId, from_user_id: asker.id, to_user_id: viewer.id } })).id
    const [adultAsk, minorAsk] = [await askedBy(adult), await askedBy(minor)]
    await stamp(minor)
    const ask = (postId: string) =>
      call(askRoute.POST, `/api/mobile/events/${eventId}/board/${postId}/requests`, viewer, { method: "POST", body: {}, params: { eventId, postId } })
    const accept = (requestId: string) =>
      call(decideRoute.PATCH, `/api/mobile/board/requests/${requestId}`, viewer, { method: "PATCH", body: { action: "accept" }, params: { requestId } })

    expect((await ask(adultPost)).status).toBe(201)
    const [toMinor, toNobody] = [await ask(minorPost), await ask(randomUUID())]
    expect(toMinor.status).toBe(404)
    expect(toMinor).toEqual(toNobody)
    expect(await db.board_requests.count({ where: { post_id: minorPost } })).toBe(0)

    expect((await accept(adultAsk)).status).toBe(200)
    const [ofMinor, ofNobody] = [await accept(minorAsk), await accept(randomUUID())]
    expect(ofMinor.status).toBe(404)
    expect(ofMinor).toEqual(ofNobody)
    expect((await db.board_requests.findUniqueOrThrow({ where: { id: minorAsk } })).status).toBe("pending")
  })
})
