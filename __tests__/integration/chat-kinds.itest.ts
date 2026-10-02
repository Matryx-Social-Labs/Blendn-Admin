import { NextRequest } from "next/server"

/*
 * Chat rooms of every kind (step 7: TQ-A10 CR-I01/I02, TQ-S07 CR-K01..K06 and
 * SEC-01, CR-I12/SEC-06). Real routes, real rows, a real socket guard.
 *
 * A room now has a kind and one owner. Only `event` and `board_post` rooms can
 * exist yet: `crew` and `blend` have no owner column until step 8, and the
 * CHECK refuses them — so their row of the probe matrix is "cannot be made",
 * proven below, and their door is pinned in chat-join-per-kind.test.ts.
 *
 * The board-post room is the one that matters here: it is the first room
 * whose door is not the event's. Its members are the post's author and the
 * askers the author accepted. A member row alone — an ask still pending, a
 * stranger — must open nothing, over HTTP or the socket.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-chat-kinds-secret-of-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import { signAccessToken } from "@/lib/mobile-auth"
import { guardJoin, type AuthenticatedSocket } from "@/lib/socket-server"
import { canJoinChat } from "@/lib/socket-auth"
import { resolveUserRef, roomHandle, roomMemberFromRef } from "@/lib/room-handle"
import { sweepExpiredChats } from "@/lib/chat-lifecycle"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const messagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const participantsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route")
const reactionsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route")
const reportRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/report/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/report/route")
const muteRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/mute/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/mute/route")
const chatListRoute = require("@/app/api/mobile/chat/groups/route") as typeof import("@/app/api/mobile/chat/groups/route")
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const wavesRoute = require("@/app/api/mobile/events/[eventId]/waves/route") as typeof import("@/app/api/mobile/events/[eventId]/waves/route")
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

async function person(label: string, role: "attendee" | "app_admin" = "attendee"): Promise<Person> {
  const id = await makeUser(testId(label), role)
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

/** A live event with a geofence, so check-in goes through the real route (and makes the event's room). */
async function liveEvent(host: string): Promise<string> {
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("ck"),
      title: "Chat kinds fixture",
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

const member = (chatGroupId: string, userId: string, status: "active" | "banned" = "active") =>
  db.chat_group_members.create({
    data: {
      chat_group_id: chatGroupId,
      user_id: userId,
      status,
      anonymous_name: testId("Heron"),
      ...(status === "banned" ? { banned_at: new Date(), banned_by: userId } : {}),
    },
  })

/** A board post with its room: the author, an accepted asker, a pending one with a stale row, a banned accepted one. */
async function boardRoom(eventId: string, author: Person, accepted: Person, pending: Person, banned: Person) {
  const post = await db.board_posts.create({
    data: { event_id: eventId, author_id: author.id, kind: "offer", body: "Two seats in the car", spaces_left: 2 },
  })
  await db.board_requests.createMany({
    data: [
      { event_id: eventId, post_id: post.id, from_user_id: accepted.id, to_user_id: author.id, status: "accepted", decided_at: new Date() },
      { event_id: eventId, post_id: post.id, from_user_id: pending.id, to_user_id: author.id, status: "pending" },
      { event_id: eventId, post_id: post.id, from_user_id: banned.id, to_user_id: author.id, status: "accepted", decided_at: new Date() },
    ],
  })
  const group = await db.chat_groups.create({
    data: { kind: "board_post", board_post_id: post.id, name: "Car to the venue", status: "active" },
  })
  await member(group.id, author.id)
  await member(group.id, accepted.id)
  // A row the owner does not stand behind: the ask was never accepted.
  await member(group.id, pending.id)
  await member(group.id, banned.id, "banned")
  const message = await db.chat_messages.create({
    data: { chat_group_id: group.id, user_id: author.id, content: "leaving at 7" },
  })
  return { postId: post.id, groupId: group.id, messageId: message.id }
}

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("the database holds the shape (CR-I01, on a migrate-deploy database)", () => {
  let eventId: string
  let postA: string
  let postB: string

  beforeAll(async () => {
    const host = await person("ck-db-host")
    eventId = await makeEvent(host.id)
    events.push(eventId)
    const post = (body: string) =>
      db.board_posts.create({ data: { event_id: eventId, author_id: host.id, kind: "chat", body }, select: { id: true } })
    postA = (await post("a")).id
    postB = (await post("b")).id
  })

  const insert = (kind: string, event: string | null, post: string | null) =>
    db.$executeRawUnsafe(
      `INSERT INTO chat_groups (id, name, kind, event_id, board_post_id) VALUES (gen_random_uuid(), 'x', $1::chat_group_kind, $2::uuid, $3::uuid)`,
      kind,
      event,
      post
    )

  it("refuses a room with two owners, none, or an owner of the wrong kind", async () => {
    const oneOwner = /23514[\s\S]*chat_groups_one_owner/
    await expect(insert("event", eventId, postA)).rejects.toThrow(oneOwner)
    await expect(insert("event", null, null)).rejects.toThrow(oneOwner)
    await expect(insert("board_post", null, null)).rejects.toThrow(oneOwner)
    await expect(insert("board_post", eventId, null)).rejects.toThrow(oneOwner)
    // No owner column yet (step 8), so no crew or Blend room can exist to be joined.
    await expect(insert("crew", null, null)).rejects.toThrow(oneOwner)
    await expect(insert("blend", null, null)).rejects.toThrow(oneOwner)
  })

  it("one room per event, one per post, and any number with no event", async () => {
    await insert("event", eventId, null)
    await expect(insert("event", eventId, null)).rejects.toThrow(/23505[\s\S]*chat_groups_event_id_key/)
    await insert("board_post", null, postA)
    await expect(insert("board_post", null, postA)).rejects.toThrow(/23505[\s\S]*chat_groups_board_post_id_key/)
    await insert("board_post", null, postB)
    expect(await db.chat_groups.count({ where: { event_id: null, board_post_id: { in: [postA, postB] } } })).toBe(2)
  })

  it("a room made the old way is an event's room", async () => {
    const host = await person("ck-db-old")
    const e = await makeEvent(host.id)
    events.push(e)
    const g = await db.chat_groups.create({ data: { event_id: e, name: "old way" }, select: { kind: true } })
    expect(g.kind).toBe("event")
  })
})

describe("who may be in a board post's room, over HTTP (SEC-01)", () => {
  let eventId: string
  let room: Awaited<ReturnType<typeof boardRoom>>
  let author: Person, accepted: Person, pending: Person, banned: Person, stranger: Person, elsewhere: Person, admin: Person

  beforeAll(async () => {
    const host = await person("ck-http-host")
    eventId = await liveEvent(host.id)
    ;[author, accepted, pending, banned, stranger, elsewhere] = await Promise.all(
      ["ck-author", "ck-accepted", "ck-pending", "ck-banned", "ck-stranger", "ck-elsewhere"].map((l) => person(l))
    )
    admin = await person("ck-admin", "app_admin")
    // The author and the accepted asker are at the event, in its room, too.
    await checkIn(eventId, author)
    await checkIn(eventId, accepted)
    room = await boardRoom(eventId, author, accepted, pending, banned)
    // Somebody checked in at another event, with a room of their own.
    const other = await liveEvent(host.id)
    await checkIn(other, elsewhere)
  })

  const read = (as: Person) =>
    Promise.all([
      call(messagesRoute.GET, `/api/mobile/chat/groups/${room.groupId}/messages`, as, { params: { chatGroupId: room.groupId } }),
      call(participantsRoute.GET, `/api/mobile/chat/groups/${room.groupId}/participants`, as, { params: { chatGroupId: room.groupId } }),
    ]).then((rs) => rs.map((r) => r.status))

  it("lets the author and an accepted asker read it", async () => {
    expect(await read(author)).toEqual([200, 200])
    expect(await read(accepted)).toEqual([200, 200])
  })

  it.each([
    ["an asker the author never accepted, holding a member row", () => pending],
    ["a stranger", () => stranger],
    ["an attendee of another event", () => elsewhere],
    ["a platform admin", () => admin],
    ["a banned member", () => banned],
  ])("refuses %s", async (_label, who) => {
    expect(await read(who())).toEqual([403, 403])
  })

  it("takes a message and a reaction from a member, and neither from the pending asker", async () => {
    const send = (as: Person) =>
      call(messagesRoute.POST, `/api/mobile/chat/groups/${room.groupId}/messages`, as, {
        method: "POST",
        body: { content: `on my way ${testId("m")}` },
        params: { chatGroupId: room.groupId },
      })
    const react = (as: Person) =>
      call(reactionsRoute.POST, `/api/mobile/chat/groups/${room.groupId}/messages/${room.messageId}/reactions`, as, {
        method: "POST",
        body: { emoji: "👍" },
        params: { chatGroupId: room.groupId, messageId: room.messageId },
      })
    expect((await send(accepted)).status).toBe(201)
    expect((await send(pending)).status).toBe(403)
    expect((await send(stranger)).status).toBe(403)
    expect((await react(pending)).status).toBe(403)
    expect([200, 201]).toContain((await react(accepted)).status)
  })

  it("mutes for a member; a room report is an event room's only, and messages are reported one by one", async () => {
    const mute = await call(muteRoute.POST, `/api/mobile/chat/groups/${room.groupId}/mute`, accepted, {
      method: "POST",
      body: {},
      params: { chatGroupId: room.groupId },
    })
    expect(mute.status).toBe(200)
    expect((await call(muteRoute.POST, `/api/mobile/chat/groups/${room.groupId}/mute`, pending, { method: "POST", body: {}, params: { chatGroupId: room.groupId } })).status).toBe(404)
    const report = await call(reportRoute.POST, `/api/mobile/chat/groups/${room.groupId}/report`, accepted, {
      method: "POST",
      body: { reason: "spam" },
      params: { chatGroupId: room.groupId },
    })
    expect(report.status).toBe(404)
    expect(await db.event_reports.count({ where: { chat_group_id: room.groupId } })).toBe(0)
  })

  it("names its people by handles that resolve in this room only (CR-I12, SEC-06)", async () => {
    const history = await call(messagesRoute.GET, `/api/mobile/chat/groups/${room.groupId}/messages`, accepted, { params: { chatGroupId: room.groupId } })
    const authorRef = (history.body.data.messages as { content: string; user: { id: string } }[]).find((m) => m.content === "leaving at 7")!.user.id
    expect(authorRef).not.toBe(author.id)
    expect(roomMemberFromRef({ kind: "board_post", groupId: room.groupId }, authorRef, accepted.id)).toBe(author.id)
    // Nowhere else: not as an event's handle, not through the profile or friend routes.
    expect(roomMemberFromRef(eventId, authorRef, accepted.id)).toBeNull()
    expect(resolveUserRef(authorRef)).toBeNull()

    // And a real event route refuses it, where the event room's own handle for
    // the same person goes through.
    const wave = (ref: string) =>
      call(wavesRoute.POST, `/api/mobile/events/${eventId}/waves`, accepted, { method: "POST", body: { toUserId: ref }, params: { eventId } })
    // Answered as somebody not in the room — which the author, checked in, is.
    const refused = await wave(authorRef)
    expect([refused.status, refused.body.errorCode]).toEqual([403, "RECIPIENT_NOT_HERE"])
    expect([200, 201]).toContain((await wave(roomHandle(eventId, author.id))).status)
  })

  it("lists only event rooms in /chat/groups, and never 500s for a member of both (CR-I02)", async () => {
    const list = await call(chatListRoute.GET, "/api/mobile/chat/groups", accepted)
    expect(list.status).toBe(200)
    const ids = (list.body.data.groups as { id: string; event: { id: string } }[]).map((g) => g.id)
    expect(ids).not.toContain(room.groupId)
    const eventRoom = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
    expect(ids).toContain(eventRoom.id)
  })
})

describe("who may join a room over the socket (CR-K01..K05, SEC-01)", () => {
  const httpServer = createServer()
  const io = new Server(httpServer)
  const clients: ClientSocket[] = []
  // The connection handler's own `join:chat`, on the real guard.
  io.on("connection", (socket) => {
    const userId = String(socket.handshake.auth.userId)
    socket.data.userId = userId
    socket.join(`user:${userId}`)
    socket.on("join:chat", (chatGroupId: string) =>
      guardJoin(socket as AuthenticatedSocket, `chat:${chatGroupId}`, "Not authorized to join this chat", () => canJoinChat(userId, chatGroupId))
    )
  })

  let eventId: string
  let room: Awaited<ReturnType<typeof boardRoom>>
  let eventRoomId: string
  let author: Person, accepted: Person, pending: Person, banned: Person, stranger: Person, admin: Person

  beforeAll(async () => {
    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = io
    const host = await person("ck-sock-host")
    eventId = await liveEvent(host.id)
    ;[author, accepted, pending, banned, stranger] = await Promise.all(
      ["ck-s-author", "ck-s-accepted", "ck-s-pending", "ck-s-banned", "ck-s-stranger"].map((l) => person(l))
    )
    admin = await person("ck-s-admin", "app_admin")
    await checkIn(eventId, author)
    room = await boardRoom(eventId, author, accepted, pending, banned)
    eventRoomId = (await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })).id
  })

  afterAll(async () => {
    for (const c of clients) c.close()
    ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = null
    await new Promise<void>((resolve) => io.close(() => resolve()))
  })

  async function joins(p: Person, chatGroupId: string) {
    const { port } = httpServer.address() as AddressInfo
    const socket = connect(`http://localhost:${port}`, { auth: { userId: p.id }, transports: ["websocket"], reconnection: false })
    clients.push(socket)
    const heard: { message: { message: { userId: string; content: string } }[]; refused: unknown[] } = { message: [], refused: [] }
    socket.on("chat:message", (m) => heard.message.push(m))
    socket.on("error", (e) => heard.refused.push(e))
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
    socket.emit("join:chat", chatGroupId)
    const sockets = () => io.in(`chat:${chatGroupId}`).fetchSockets()
    for (let waited = 0; waited < 2000; waited += 25) {
      if (heard.refused.length || (await sockets()).some((s) => s.data.userId === p.id)) break
      await new Promise((r) => setTimeout(r, 25))
    }
    return { heard, inRoom: (await sockets()).some((s) => s.data.userId === p.id) }
  }

  it("lets the author and an accepted asker into the board post's room, and nobody else", async () => {
    expect((await joins(author, room.groupId)).inRoom).toBe(true)
    expect((await joins(accepted, room.groupId)).inRoom).toBe(true)
    for (const who of [pending, banned, stranger, admin]) {
      const j = await joins(who, room.groupId)
      expect({ who: who.id, inRoom: j.inRoom, refused: j.heard.refused }).toEqual({
        who: who.id,
        inRoom: false,
        refused: [{ message: "Not authorized to join this chat", code: "FORBIDDEN" }],
      })
    }
  })

  it("does not cross kinds: the board room's people are not in the event's room by it, and the event's are not in the board's", async () => {
    // The accepted asker is not at the event: their board seat is no key to its room.
    expect((await joins(accepted, eventRoomId)).inRoom).toBe(false)
    // The author is in both, each on its own door.
    expect((await joins(author, eventRoomId)).inRoom).toBe(true)
    await expect(canJoinChat(stranger.id, eventRoomId)).resolves.toBe(false)
  })

  it("delivers a message to the room's members only, under a handle scoped to the room (CR-K06)", async () => {
    const listener = await joins(accepted, room.groupId)
    const outsider = await joins(stranger, room.groupId)
    const content = `meet at the gate ${testId("k")}`
    const sent = await call(messagesRoute.POST, `/api/mobile/chat/groups/${room.groupId}/messages`, author, {
      method: "POST",
      body: { content },
      params: { chatGroupId: room.groupId },
    })
    expect(sent.status).toBe(201)
    for (let waited = 0; !listener.heard.message.some((m) => m.message.content === content) && waited < 3000; waited += 50) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const delivered = listener.heard.message.find((m) => m.message.content === content)
    expect(delivered).toBeDefined()
    expect(delivered!.message.userId).not.toBe(author.id)
    expect(roomMemberFromRef({ kind: "board_post", groupId: room.groupId }, delivered!.message.userId, accepted.id)).toBe(author.id)
    expect(roomMemberFromRef(eventId, delivered!.message.userId, accepted.id)).toBeNull()
    expect(outsider.heard.message).toEqual([])
  })
})

describe("the chat sweeper closes event rooms by their event, and leaves other kinds alone (CR-I02)", () => {
  it("archives an ended event's room and not a board post room on the same event", async () => {
    const host = await person("ck-sweep-host")
    const ended = await db.events.create({
      data: {
        slug: testId("ck-ended"),
        title: "Ended",
        description: "integration fixture",
        start_time: new Date(Date.now() - 4 * 24 * 60 * 60_000),
        end_time: new Date(Date.now() - 3 * 24 * 60 * 60_000),
        timezone: "UTC",
        status: "published",
        organizer_id: host.id,
      },
      select: { id: true },
    })
    events.push(ended.id)
    const eventRoom = await db.chat_groups.create({ data: { event_id: ended.id, name: "ended", status: "active" } })
    const post = await db.board_posts.create({ data: { event_id: ended.id, author_id: host.id, kind: "chat", body: "after" } })
    const postRoom = await db.chat_groups.create({ data: { kind: "board_post", board_post_id: post.id, name: "after", status: "active" } })

    for (let pass = 0; pass < 20 && (await sweepExpiredChats()).hasMore; pass++);

    const after = await db.chat_groups.findMany({ where: { id: { in: [eventRoom.id, postRoom.id] } }, select: { id: true, status: true } })
    expect(Object.fromEntries(after.map((g) => [g.id, g.status]))).toEqual({ [eventRoom.id]: "archived", [postRoom.id]: "active" })
  })
})
