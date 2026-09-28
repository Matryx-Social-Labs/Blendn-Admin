import { NextRequest } from "next/server"

/*
 * Room handles close the friend's-eye view of a room (SCRUM-371).
 *
 * The threat, as it was: Ana and Ben are friends, so Ana holds Ben's real user
 * id (the friends list and a friend DM carry it). Ben's `friends_see_me_in_rooms`
 * is off — he chose to be a stranger to his friends in rooms. Every room
 * surface nevertheless sent each attendee's real id beside their pseudonym, so
 * Ana read which card was Ben straight off the network, and anyone who knew his
 * id from anywhere could follow his pseudonyms from event to event.
 *
 * This drives the real routes against a real database — check-in through the
 * check-in route, messages through both send routes — and then reads every
 * room surface as Ana and searches the serialised JSON for Ben's real id. It
 * must appear nowhere. Then Ana does everything a room lets her do to Ben,
 * using only what the roster gave her, and each row lands on Ben.
 *
 * The second half is the probing oracle the coordinator added: a response that
 * differs because a friendship or a friend DM exists picks out the friend's
 * handle just as surely as the id did.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-room-handles-secret-of-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { randomUUID } from "crypto"
import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { resolveUserRef, roomHandle } from "@/lib/room-handle"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const rosterRoute = require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route")
const eventChatRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
const groupMessagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const participantsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route")
const chatListRoute = require("@/app/api/mobile/chat/groups/route") as typeof import("@/app/api/mobile/chat/groups/route")
const matchesRoute = require("@/app/api/mobile/events/[eventId]/matches/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/route")
const likesRoute = require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route")
const wavesRoute = require("@/app/api/mobile/events/[eventId]/waves/route") as typeof import("@/app/api/mobile/events/[eventId]/waves/route")
const userRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const blockRoute = require("@/app/api/mobile/users/[userId]/block/route") as typeof import("@/app/api/mobile/users/[userId]/block/route")
const reportRoute = require("@/app/api/mobile/users/[userId]/report/route") as typeof import("@/app/api/mobile/users/[userId]/report/route")
const requestsRoute = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
const respondRoute = require("@/app/api/mobile/message-requests/[requestId]/respond/route") as typeof import("@/app/api/mobile/message-requests/[requestId]/respond/route")
const friendRoute = require("@/app/api/mobile/friends/[userId]/route") as typeof import("@/app/api/mobile/friends/[userId]/route")
const friendDmRoute = require("@/app/api/mobile/friends/[userId]/conversation/route") as typeof import("@/app/api/mobile/friends/[userId]/conversation/route")
const conversationsRoute = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")
const interestsRoute = require("@/app/api/mobile/profiles/[userId]/interests/route") as typeof import("@/app/api/mobile/profiles/[userId]/interests/route")
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

/** A live event with a geofence, so check-in goes through the real route. */
async function liveEvent(): Promise<string> {
  const host = await makeUser(testId("rh-host"), "organizer")
  users.push(host)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("rh"),
      title: "Room handles fixture",
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

async function befriend(a: Person, b: Person) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  await db.friendships.create({ data: { user1_id, user2_id } })
}

const roster = async (eventId: string, as: Person) =>
  (await call(rosterRoute.GET, `/api/mobile/events/${eventId}/checkins`, as, { params: { eventId } })).body.data
    .attendees as { userId: string; name: string }[]

/** The ref the roster gives `as` for `whom`: found by resolving, as the server would. */
async function rosterRef(eventId: string, as: Person, whom: Person): Promise<string> {
  const row = (await roster(eventId, as)).find((a) => resolveUserRef(a.userId)?.userId === whom.id)
  if (!row) throw new Error("not on the roster")
  return row.userId
}

/** Key structure with every leaf reduced to its type, so ids and times drop out. */
const shapeOf = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(shapeOf)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]))
      : typeof v

afterAll(async () => {
  await db.categories.deleteMany({ where: { slug: { in: categorySlugs } } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

describe("a friend who holds your real id reads the room and finds nothing", () => {
  let eventId: string
  let chatGroupId: string
  let ana: Person, ben: Person, cam: Person
  let hBen: string

  beforeAll(async () => {
    eventId = await liveEvent()
    ;[ana, ben, cam] = [await person("rh-ana"), await person("rh-ben"), await person("rh-cam")]
    for (const p of [ana, ben, cam]) await checkIn(eventId, p)
    chatGroupId = (await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })).id
    // Friends, with Ben's switch at its default: off.
    await befriend(ana, ben)

    const post = (p: Person, content: string) =>
      call(eventChatRoute.POST, `/api/mobile/events/${eventId}/chat`, p, {
        method: "POST",
        body: { content },
        params: { eventId },
      })
    expect((await post(ana, "hello from the viewer")).status).toBe(201)
    expect((await post(cam, "hello from a stranger")).status).toBe(201)
    const camsMessage = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: chatGroupId, user_id: cam.id } })
    // Ben replies to Cam through the other write path, quoting her.
    const reply = await call(groupMessagesRoute.POST, `/api/mobile/chat/groups/${chatGroupId}/messages`, ben, {
      method: "POST",
      body: { content: "replying to the stranger", parentId: camsMessage.id },
      params: { chatGroupId },
    })
    expect(reply.status).toBe(201)

    hBen = await rosterRef(eventId, ana, ben)
  })

  it("the roster lists Ben by a handle that resolves to him, and Ana by her own id", async () => {
    const rows = await roster(eventId, ana)
    expect(hBen.startsWith("rh_")).toBe(true)
    expect(resolveUserRef(hBen)).toEqual({ userId: ben.id, eventId })
    expect(rows.map((r) => r.userId)).toContain(ana.id)
  })

  it("Ben's real id appears in none of the room surfaces Ana can read", async () => {
    const surfaces = {
      roster: await call(rosterRoute.GET, `/api/mobile/events/${eventId}/checkins`, ana, { params: { eventId } }),
      eventChat: await call(eventChatRoute.GET, `/api/mobile/events/${eventId}/chat`, ana, { params: { eventId } }),
      groupHistory: await call(groupMessagesRoute.GET, `/api/mobile/chat/groups/${chatGroupId}/messages`, ana, {
        params: { chatGroupId },
      }),
      participants: await call(participantsRoute.GET, `/api/mobile/chat/groups/${chatGroupId}/participants`, ana, {
        params: { chatGroupId },
      }),
      matches: await call(matchesRoute.GET, `/api/mobile/events/${eventId}/matches`, ana, { params: { eventId } }),
      chatList: await call(chatListRoute.GET, "/api/mobile/chat/groups", ana),
    }
    for (const [name, res] of Object.entries(surfaces)) {
      expect({ name, status: res.status }).toEqual({ name, status: 200 })
      const json = JSON.stringify(res.body)
      expect({ name, leaksBen: json.includes(ben.id), leaksCam: json.includes(cam.id) }).toEqual({
        name,
        leaksBen: false,
        leaksCam: false,
      })
      // And Ben is there, under the handle — the surface did not just drop him.
      if (name !== "chatList") expect({ name, hasBen: json.includes(hBen) }).toEqual({ name, hasBen: true })
    }

    // The same handle everywhere, so the client can match a card to a message.
    const history = surfaces.groupHistory.body.data.messages as {
      user: { id: string; name: string }
      user_id: string
      content: string
      parent_message: { user: { id: string; name: string } } | null
    }[]
    const bensReply = history.find((m) => m.content === "replying to the stranger")!
    expect(bensReply.user.id).toBe(hBen)
    expect(bensReply.user_id).toBe(hBen)
    expect(bensReply.parent_message!.user.id).toBe(roomHandle(eventId, cam.id))
    const own = history.find((m) => m.content === "hello from the viewer")!
    expect(own.user.id).toBe(ana.id)
    expect(surfaces.chatList.body.data.groups[0].lastMessage.user.id).toBe(hBen)

    // A room push used to be stored in the bell and served back, carrying the
    // sender. Room messages write no bell row now (`NOT_IN_THE_BELL`), and the
    // reply push itself — to Cam, not Ana — is checked for Ben's real id in
    // `push-bursts.itest.ts`.
    expect(await db.notifications.count({ where: { user_id: { in: [ana.id, cam.id] }, kind: "group_message" } })).toBe(0)
  })

  it("the quoted author keeps their own name in the reply's response, not the sender's", async () => {
    const camsMessage = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: chatGroupId, user_id: cam.id } })
    const res = await call(groupMessagesRoute.POST, `/api/mobile/chat/groups/${chatGroupId}/messages`, ben, {
      method: "POST",
      body: { content: "and again", parentId: camsMessage.id },
      params: { chatGroupId },
    })
    const names = await db.chat_group_members.findMany({
      where: { chat_group_id: chatGroupId, user_id: { in: [ben.id, cam.id] } },
      select: { user_id: true, anonymous_name: true },
    })
    const pseudonym = (p: Person) => names.find((n) => n.user_id === p.id)!.anonymous_name
    expect(res.body.data.user.id).toBe(ben.id)
    expect(res.body.data.parent_message.user).toEqual({ id: roomHandle(eventId, cam.id), name: pseudonym(cam) })
    expect(pseudonym(cam)).not.toBe(pseudonym(ben))
  })

  it("Ben's own view of the roster lists him by his real id", async () => {
    const rows = await roster(eventId, ben)
    expect(rows.map((r) => r.userId)).toContain(ben.id)
    expect(JSON.stringify(rows)).not.toContain(ana.id)
  })

  it("the profile routes echo the handle and never the id behind it", async () => {
    const card = await call(userRoute.GET, `/api/mobile/users/${hBen}`, ana, { params: { userId: hBen } })
    expect(card.status).toBe(200)
    expect(card.body.data).toMatchObject({ id: hBen, identityVisible: false, isOwnProfile: false })
    // A friend with the switch off: nothing about what is open between them.
    expect(card.body.data).not.toHaveProperty("connection")
    expect(JSON.stringify(card.body)).not.toContain(ben.id)

    const profile = await call(profileRoute.GET, `/api/mobile/profiles/${hBen}`, ana, { params: { userId: hBen } })
    expect(profile.status).toBe(200)
    expect(profile.body.data.id).toBe(hBen)
    expect(profile.body.data.profile.id).toBe(hBen)
    expect(JSON.stringify(profile.body)).not.toContain(ben.id)

    // Your own profile, by your own handle, is yours.
    const hAna = roomHandle(eventId, ana.id)
    const mine = await call(userRoute.GET, `/api/mobile/users/${hAna}`, ana, { params: { userId: hAna } })
    expect(mine.body.data).toMatchObject({ id: ana.id, isOwnProfile: true })
  })

  it("a forged handle is answered exactly as an unknown id", async () => {
    const body = Buffer.from(hBen.slice(3), "base64url")
    body[body.length - 1] ^= 0x01
    const forged = `rh_${body.toString("base64url")}`
    const nobody = testId("nobody")
    for (const ref of [forged, nobody]) expect(resolveUserRef(ref)?.userId ?? ref).not.toBe(ben.id)

    const answers = async (ref: string) => [
      await call(userRoute.GET, `/api/mobile/users/${ref}`, ana, { params: { userId: ref } }),
      await call(likesRoute.POST, `/api/mobile/events/${eventId}/matches/likes`, ana, {
        method: "POST",
        body: { userId: ref },
        params: { eventId },
      }),
      await call(wavesRoute.POST, `/api/mobile/events/${eventId}/waves`, ana, {
        method: "POST",
        body: { toUserId: ref },
        params: { eventId },
      }),
      await call(reportRoute.POST, `/api/mobile/users/${ref}/report`, ana, {
        method: "POST",
        body: { reason: "spam" },
        params: { userId: ref },
      }),
      await call(requestsRoute.POST, "/api/mobile/message-requests", ana, {
        method: "POST",
        body: { recipientId: ref, message: "hi" },
      }),
      await call(blockRoute.POST, `/api/mobile/users/${ref}/block`, ana, { method: "POST", params: { userId: ref } }),
      await call(blockRoute.DELETE, `/api/mobile/users/${ref}/block`, ana, { method: "DELETE", params: { userId: ref } }),
      await call(profileRoute.GET, `/api/mobile/profiles/${ref}`, ana, { params: { userId: ref } }),
      await call(interestsRoute.GET, `/api/mobile/profiles/${ref}/interests`, ana, { params: { userId: ref } }),
    ]
    expect(await answers(forged)).toEqual(await answers(nobody))
    // Nothing reached Ben by the forged handle.
    expect(await db.blocked_users.count({ where: { blocker_id: ana.id, blocked_id: ben.id } })).toBe(0)
  })

  it("interests read through the roster's handle are Ben's", async () => {
    const slug = testId("rh-cat")
    categorySlugs.push(slug)
    const category = await db.categories.create({ data: { name: "Board games", slug } })
    await db.user_interests.create({ data: { user_id: ben.id, category_id: category.id } })
    const read = (ref: string) =>
      call(interestsRoute.GET, `/api/mobile/profiles/${ref}/interests`, ana, { params: { userId: ref } })
    const [byHandle, byRawId] = [await read(hBen), await read(ben.id)]
    expect(byHandle.status).toBe(200)
    expect(byHandle.body.data.interests.map((i: { slug: string }) => i.slug)).toEqual([slug])
    expect(byHandle).toEqual(byRawId)
  })

  it("likes and waves take only this room's handles: a raw id or another room's handle is nobody", async () => {
    /*
     * Cam is checked in and visible, so a raw-id like or wave used to answer
     * "yes, that account is in this room right now". Now it is answered as an
     * id nobody has, and so is Cam's handle from another event.
     */
    const act = async (ref: string) => [
      await call(likesRoute.POST, `/api/mobile/events/${eventId}/matches/likes`, ana, {
        method: "POST",
        body: { userId: ref },
        params: { eventId },
      }),
      await call(wavesRoute.POST, `/api/mobile/events/${eventId}/waves`, ana, {
        method: "POST",
        body: { toUserId: ref },
        params: { eventId },
      }),
    ]
    const unknown = await act(testId("nobody"))
    expect(unknown.map((r) => r.status)).toEqual([404, 403])
    expect(await act(cam.id)).toEqual(unknown)
    expect(await act(roomHandle(randomUUID(), cam.id))).toEqual(unknown)
    expect(await db.event_likes.count({ where: { liker_id: ana.id, liked_id: cam.id } })).toBe(0)

    // The too-soon finder is closed: the refused raw-id wave started no
    // window, so the first wave by the roster's handle goes through.
    const byHandle = await call(wavesRoute.POST, `/api/mobile/events/${eventId}/waves`, ana, {
      method: "POST",
      body: { toUserId: await rosterRef(eventId, ana, cam) },
      params: { eventId },
    })
    expect(byHandle.status).toBe(200)
  })

  it("everything the room lets Ana do to Ben works with the roster's handle, and lands on Ben", async () => {
    const like = await call(likesRoute.POST, `/api/mobile/events/${eventId}/matches/likes`, ana, {
      method: "POST",
      body: { userId: hBen },
      params: { eventId },
    })
    expect(like).toEqual({ status: 200, body: expect.objectContaining({ data: { mutual: false } }) })
    expect(await db.event_likes.count({ where: { event_id: eventId, liker_id: ana.id, liked_id: ben.id } })).toBe(1)

    const wave = await call(wavesRoute.POST, `/api/mobile/events/${eventId}/waves`, ana, {
      method: "POST",
      body: { toUserId: hBen },
      params: { eventId },
    })
    expect(wave.status).toBe(200)
    // One wave per pair per ten minutes still holds by handle.
    const again = await call(wavesRoute.POST, `/api/mobile/events/${eventId}/waves`, ana, {
      method: "POST",
      body: { toUserId: hBen },
      params: { eventId },
    })
    expect(again.status).toBe(429)

    const request = await call(requestsRoute.POST, "/api/mobile/message-requests", ana, {
      method: "POST",
      body: { recipientId: hBen, message: "we were both at the thing" },
    })
    expect(request.status).toBe(201)
    expect(request.body.data.request).toMatchObject({ recipientId: hBen, recipient: { id: hBen } })
    expect(await db.message_requests.count({ where: { sender_id: ana.id, recipient_id: ben.id } })).toBe(1)

    const report = await call(reportRoute.POST, `/api/mobile/users/${hBen}/report`, ana, {
      method: "POST",
      body: { reason: "spam" },
      params: { userId: hBen },
    })
    expect(report.status).toBe(201)
    expect(await db.user_reports.count({ where: { reporter_id: ana.id, reported_id: ben.id } })).toBe(1)

    const block = await call(blockRoute.POST, `/api/mobile/users/${hBen}/block`, ana, {
      method: "POST",
      params: { userId: hBen },
    })
    expect(block.status).toBe(200)
    expect(await db.blocked_users.count({ where: { blocker_id: ana.id, blocked_id: ben.id } })).toBe(1)

    const unblock = await call(blockRoute.DELETE, `/api/mobile/users/${hBen}/block`, ana, {
      method: "DELETE",
      params: { userId: hBen },
    })
    expect(unblock.status).toBe(200)
    expect(await db.blocked_users.count({ where: { blocker_id: ana.id, blocked_id: ben.id } })).toBe(0)
  })
})

describe("a response that differs for a friend is the id by another route", () => {
  let eventId: string
  let ana: Person, ben: Person, sam: Person
  let hBen: string, hSam: string
  let dmId: string

  const request = (ref: string) =>
    call(requestsRoute.POST, "/api/mobile/message-requests", ana, {
      method: "POST",
      body: { recipientId: ref, message: "we met by the bar" },
    })
  const setSwitch = (on: boolean) =>
    db.profiles.update({ where: { id: ben.id }, data: { friends_see_me_in_rooms: on } })
  const requestPushesTo = async (p: Person) => {
    await new Promise((r) => setTimeout(r, 300))
    return db.notifications.count({ where: { user_id: p.id, kind: "message_request" } })
  }

  beforeAll(async () => {
    eventId = await liveEvent()
    ;[ana, ben, sam] = [await person("rho-ana"), await person("rho-ben"), await person("rho-sam")]
    for (const p of [ana, ben, sam]) await checkIn(eventId, p)
    await befriend(ana, ben)
    // An open friend DM: deliberately not a way to recognise Ben in a room.
    const dm = await call(friendDmRoute.POST, `/api/mobile/friends/${ben.id}/conversation`, ana, {
      method: "POST",
      params: { userId: ben.id },
    })
    expect(dm.status).toBe(200)
    dmId = dm.body.data.conversationId
    hBen = await rosterRef(eventId, ana, ben)
    hSam = await rosterRef(eventId, ana, sam)
  })

  it("a message request to the friend's handle answers exactly as one to a stranger's, and writes nothing", async () => {
    const [toBen, toSam] = [await request(hBen), await request(hSam)]
    expect(toBen.status).toBe(201)
    expect(toSam.status).toBe(201)
    expect(shapeOf(toBen.body)).toEqual(shapeOf(toSam.body))
    expect(toBen.body.data.request).toMatchObject({ recipientId: hBen, recipient: { id: hBen }, status: "pending" })

    expect(await db.message_requests.count({ where: { sender_id: ana.id, recipient_id: ben.id } })).toBe(0)
    expect(await requestPushesTo(ben)).toBe(0)
    // The control: the stranger's request is real.
    expect(await db.message_requests.count({ where: { sender_id: ana.id, recipient_id: sam.id } })).toBe(1)
    expect(await requestPushesTo(sam)).toBe(1)

    // Asking again reads the same for both: already asked, and a friend DM,
    // are both a fresh-looking 201, and neither writes a second row.
    const [againBen, againSam] = [await request(hBen), await request(hSam)]
    expect([againBen.status, againSam.status]).toEqual([201, 201])
    expect(shapeOf(againBen.body)).toEqual(shapeOf(againSam.body))
    expect(await db.message_requests.count({ where: { sender_id: ana.id, recipient_id: sam.id } })).toBe(1)
  })

  it("the id it answers with cannot be told from a real one by asking the respond route about it", async () => {
    const synthetic = (await request(hBen)).body.data.request.id as string
    const real = (await db.message_requests.findFirstOrThrow({ where: { sender_id: ana.id, recipient_id: sam.id } })).id
    const ask = (requestId: string) =>
      call(respondRoute.POST, `/api/mobile/message-requests/${requestId}/respond`, ana, {
        method: "POST",
        body: { action: "accept" },
        params: { requestId },
      })
    expect(await ask(synthetic)).toEqual(await ask(real))
  })

  it("the friends routes and POST /conversations answer the friend's handle as a stranger's", async () => {
    const byRef = async (ref: string) => [
      await call(friendRoute.GET, `/api/mobile/friends/${ref}`, ana, { params: { userId: ref } }),
      await call(friendDmRoute.POST, `/api/mobile/friends/${ref}/conversation`, ana, {
        method: "POST",
        params: { userId: ref },
      }),
      await call(conversationsRoute.POST, "/api/mobile/conversations", ana, {
        method: "POST",
        body: { otherUserId: ref },
      }),
    ]
    const [ben404, sam404] = [await byRef(hBen), await byRef(hSam)]
    expect(ben404.map((r) => r.status)).toEqual([404, 404, 404])
    expect(ben404).toEqual(sam404)
    // The raw id still works for a friend who holds it — nothing new learned.
    expect((await call(friendRoute.GET, `/api/mobile/friends/${ben.id}`, ana, { params: { userId: ben.id } })).status).toBe(200)
  })

  it("the friend stays in the deck as the stranger they chose to be", async () => {
    const deck = await call(matchesRoute.GET, `/api/mobile/events/${eventId}/matches`, ana, { params: { eventId } })
    const refs = (deck.body.data.matches as { userId: string }[]).map((m) => m.userId)
    expect(refs).toEqual(expect.arrayContaining([hBen, hSam]))
  })

  it("the card says nothing about the friend DM while the switch is off", async () => {
    const card = await call(userRoute.GET, `/api/mobile/users/${hBen}`, ana, { params: { userId: hBen } })
    expect(card.body.data.identityVisible).toBe(false)
    expect(card.body.data).not.toHaveProperty("connection")
  })

  describe("once Ben lets friends recognise him", () => {
    beforeAll(() => setSwitch(true))
    afterAll(() => setSwitch(false))

    it("the card carries what is open between them", async () => {
      const card = await call(userRoute.GET, `/api/mobile/users/${hBen}`, ana, { params: { userId: hBen } })
      expect(card.body.data).toMatchObject({ id: hBen, identityVisible: true, connection: { conversationId: dmId, request: null } })
    })

    it("a request to him is refused as it always was — Ana knows who this is", async () => {
      const res = await request(hBen)
      expect(res).toEqual({
        status: 409,
        body: expect.objectContaining({ error: "You already have a conversation with this user" }),
      })
    })

    it("his handle opens the friend DM through either route", async () => {
      const viaFriends = await call(friendDmRoute.POST, `/api/mobile/friends/${hBen}/conversation`, ana, {
        method: "POST",
        params: { userId: hBen },
      })
      expect(viaFriends).toEqual({ status: 200, body: expect.objectContaining({ data: { conversationId: dmId } }) })
      const viaConversations = await call(conversationsRoute.POST, "/api/mobile/conversations", ana, {
        method: "POST",
        body: { otherUserId: hBen },
      })
      expect(viaConversations.status).toBe(200)
      expect(viaConversations.body.data.id).toBe(dmId)
    })

    it("his handle opens the friend routes, and he leaves Ana's deck", async () => {
      expect((await call(friendRoute.GET, `/api/mobile/friends/${hBen}`, ana, { params: { userId: hBen } })).status).toBe(200)
      const deck = await call(matchesRoute.GET, `/api/mobile/events/${eventId}/matches`, ana, { params: { eventId } })
      expect((deck.body.data.matches as { userId: string }[]).map((m) => m.userId)).not.toContain(hBen)
    })

    it("a pending request shows on the card from either side", async () => {
      await db.message_requests.create({ data: { sender_id: ben.id, recipient_id: ana.id, message: "hey", status: "pending" } })
      const card = await call(userRoute.GET, `/api/mobile/users/${hBen}`, ana, { params: { userId: hBen } })
      expect(card.body.data.connection).toEqual({ conversationId: dmId, request: "received" })
      await db.message_requests.deleteMany({ where: { sender_id: ben.id, recipient_id: ana.id } })
    })
  })
})

describe("the live room names people by the same handle the roster does", () => {
  /*
   * A real socket.io server installed as the app's `io`, as in
   * `live-room-honours-blocks.itest.ts`, with each client in its own
   * `user:<id>` room as the connection handler puts it. The likes and the wave
   * go through the real routes, using the refs each person's roster gave them.
   */
  const httpServer = createServer()
  const io = new Server(httpServer)
  const clients: ClientSocket[] = []
  io.on("connection", (socket) => {
    const userId = String(socket.handshake.auth.userId)
    socket.data.userId = userId
    socket.join(`user:${userId}`)
  })
  type Heard = { match: { otherUserId: string }[]; wave: { fromUserId: string }[] }
  async function listen(p: Person): Promise<Heard> {
    const { port } = httpServer.address() as AddressInfo
    const socket = connect(`http://localhost:${port}`, { auth: { userId: p.id }, transports: ["websocket"] })
    clients.push(socket)
    const heard: Heard = { match: [], wave: [] }
    socket.on("room:match", (x) => heard.match.push(x))
    socket.on("room:wave", (x) => heard.wave.push(x))
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
    return heard
  }

  let eventId: string
  let ana: Person, cam: Person

  beforeAll(async () => {
    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = io
    eventId = await liveEvent()
    ;[ana, cam] = [await person("rhs-ana"), await person("rhs-cam")]
    for (const p of [ana, cam]) await checkIn(eventId, p)
  })

  afterAll(async () => {
    for (const c of clients) c.close()
    ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = null
    await new Promise<void>((resolve) => io.close(() => resolve()))
  })

  it("room:match and room:wave carry the roster's ref for the other person, and no real id", async () => {
    const [anaHears, camHears] = [await listen(ana), await listen(cam)]
    const camOnAnasRoster = await rosterRef(eventId, ana, cam)
    const anaOnCamsRoster = await rosterRef(eventId, cam, ana)

    const like = (as: Person, ref: string) =>
      call(likesRoute.POST, `/api/mobile/events/${eventId}/matches/likes`, as, {
        method: "POST",
        body: { userId: ref },
        params: { eventId },
      })
    expect((await like(ana, camOnAnasRoster)).body.data.mutual).toBe(false)
    expect((await like(cam, anaOnCamsRoster)).body.data.mutual).toBe(true)
    const wave = await call(wavesRoute.POST, `/api/mobile/events/${eventId}/waves`, cam, {
      method: "POST",
      body: { toUserId: anaOnCamsRoster },
      params: { eventId },
    })
    expect(wave.status).toBe(200)
    await new Promise((r) => setTimeout(r, 200))

    expect(anaHears.match.map((m) => m.otherUserId)).toEqual([camOnAnasRoster])
    expect(camHears.match.map((m) => m.otherUserId)).toEqual([anaOnCamsRoster])
    expect(anaHears.wave.map((w) => w.fromUserId)).toEqual([camOnAnasRoster])
    expect(JSON.stringify(anaHears)).not.toContain(cam.id)
    expect(JSON.stringify(camHears)).not.toContain(ana.id)
  })
})
