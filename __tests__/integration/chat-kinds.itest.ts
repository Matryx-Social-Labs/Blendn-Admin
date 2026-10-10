import { NextRequest } from "next/server"

/*
 * Chat rooms of every kind (step 7: TQ-A10 CR-I01/I02, TQ-S07 CR-K01..K06 and
 * SEC-01, CR-I12/SEC-06). Real routes, real rows, and the real socket server:
 * `initSocketServer` with its own auth and `join:chat` handler, clients that
 * sign in with a mobile token.
 *
 * A room now has a kind and one owner. Crew and Blend rooms have their own
 * suites (crews.itest.ts, blends.itest.ts, step 8); here a crew or Blend room
 * without its owner is refused by the CHECK, and their doors are pinned in
 * chat-join-per-kind.test.ts.
 *
 * The board-post room is the one that matters here: it is the first room
 * whose door is not the event's. Its people are the post's author and the
 * askers the author accepted. A member row alone — an ask still pending, a
 * stranger — must open nothing, over HTTP or the socket, and a room its owner
 * closes (withdrawn, taken down, the ask undone, a block, its clock) must stop
 * reaching the people already in it.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-chat-kinds-secret-of-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { createServer } from "http"
import type { AddressInfo } from "net"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import { signAccessToken } from "@/lib/mobile-auth"
import {
  emitChatMemberBanned,
  emitChatMemberMuted,
  emitChatMessage,
  initSocketServer,
} from "@/lib/socket-server"
import { logger } from "@/lib/logger"
import { stopSponsoredScheduler } from "@/lib/sponsored-scheduler"
import { canJoinChat } from "@/lib/socket-auth"
import { resolveUserRef, roomHandle, roomMemberFromRef, type RoomScope } from "@/lib/room-handle"
import { sweepExpiredChats } from "@/lib/chat-lifecycle"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const messagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const participantsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route")
const reactionsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route")
const roomReportRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/report/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/report/route")
const messageReportRoute = require("@/app/api/mobile/messages/[messageId]/report/route") as typeof import("@/app/api/mobile/messages/[messageId]/report/route")
const muteRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/mute/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/mute/route")
const leaveRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/leave/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/leave/route")
const chatListRoute = require("@/app/api/mobile/chat/groups/route") as typeof import("@/app/api/mobile/chat/groups/route")
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const wavesRoute = require("@/app/api/mobile/events/[eventId]/waves/route") as typeof import("@/app/api/mobile/events/[eventId]/waves/route")
const likesRoute = require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route")
const withdrawRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/route")
const userRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
const userReportRoute = require("@/app/api/mobile/users/[userId]/report/route") as typeof import("@/app/api/mobile/users/[userId]/report/route")
const blockRoute = require("@/app/api/mobile/users/[userId]/block/route") as typeof import("@/app/api/mobile/users/[userId]/block/route")
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
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
const orgs: string[] = []

async function person(label: string, role: "attendee" | "organizer" | "app_admin" = "attendee"): Promise<Person> {
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
async function liveEvent(host: string, orgId?: string, endsIn = 2 * 60 * 60_000): Promise<string> {
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("ck"),
      title: "Chat kinds fixture",
      description: "integration fixture",
      start_time: new Date(now - 30 * 60_000),
      end_time: new Date(now + endsIn),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: host,
      ...(orgId && { organizer_org_id: orgId }),
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

type Seat = "active" | "pending" | "banned" | "left" | "muted" | "automuted"
async function seat(chatGroupId: string, userId: string, how: Seat, by: string) {
  const status = how === "pending" ? "active" : how === "automuted" ? "muted" : how
  await db.chat_group_members.create({
    data: {
      chat_group_id: chatGroupId,
      user_id: userId,
      status,
      anonymous_name: testId("Heron"),
      ...(how === "banned" && { banned_at: new Date(), banned_by: by }),
      ...(how === "left" && { left_at: new Date() }),
      ...(how === "muted" && { muted_at: new Date(), muted_by: by }),
      ...(how === "automuted" && { muted_at: new Date(Date.now() - 2 * 60 * 60_000) }),
    },
  })
}

/**
 * One event, its host (an organisation that operates it), and a board post
 * with its room: the author, accepted askers in every member state, an ask
 * still pending holding a member row, and people who have no business there.
 */
async function world(label: string, opts: { endsIn?: number } = {}) {
  const host = await person(`${label}-host`, "organizer")
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("ck-org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host.id, role: "owner" } })
  const eventId = await liveEvent(host.id, org.id, opts.endsIn)
  const [author, accepted, pending, banned, left, muted, automuted, stranger, sameEvent, elsewhere] = await Promise.all(
    ["author", "accepted", "pending", "banned", "left", "muted", "automuted", "stranger", "same-event", "elsewhere"].map((l) =>
      person(`${label}-${l}`)
    )
  )
  const admin = await person(`${label}-admin`, "app_admin")
  // At the event, in its room: the author, an accepted asker, and somebody who never asked.
  for (const p of [author, accepted, sameEvent]) await checkIn(eventId, p)
  const other = await liveEvent(host.id)
  await checkIn(other, elsewhere)

  const post = await db.board_posts.create({
    data: { event_id: eventId, author_id: author.id, kind: "offer", body: "Two seats in the car", spaces_left: 4 },
  })
  const ask = (p: Person, status: "accepted" | "pending") =>
    db.board_requests.create({
      data: {
        event_id: eventId,
        post_id: post.id,
        from_user_id: p.id,
        to_user_id: author.id,
        status,
        ...(status === "accepted" && { decided_at: new Date() }),
      },
      select: { id: true },
    })
  const acceptedAsk = await ask(accepted, "accepted")
  for (const p of [banned, left, muted, automuted]) await ask(p, "accepted")
  await ask(pending, "pending")

  const room = await db.chat_groups.create({
    data: { kind: "board_post", board_post_id: post.id, name: "Car to the venue", status: "active" },
  })
  await seat(room.id, author.id, "active", author.id)
  await seat(room.id, accepted.id, "active", author.id)
  // A row the owner does not stand behind: the ask was never accepted.
  await seat(room.id, pending.id, "pending", author.id)
  await seat(room.id, banned.id, "banned", author.id)
  await seat(room.id, left.id, "left", author.id)
  await seat(room.id, muted.id, "muted", author.id)
  await seat(room.id, automuted.id, "automuted", author.id)
  const message = await db.chat_messages.create({ data: { chat_group_id: room.id, user_id: author.id, content: "leaving at 7" } })
  const eventRoomId = (await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })).id

  return {
    eventId,
    postId: post.id,
    acceptedAskId: acceptedAsk.id,
    groupId: room.id,
    eventRoomId,
    messageId: message.id,
    scope: { kind: "board_post", groupId: room.id } as RoomScope,
    people: { host, author, accepted, pending, banned, left, muted, automuted, stranger, sameEvent, elsewhere, admin },
  }
}
type World = Awaited<ReturnType<typeof world>>

const ops = (w: World) => {
  const g = w.groupId
  const p = { chatGroupId: g }
  return {
    read: (as: Person) => call(messagesRoute.GET, `/api/mobile/chat/groups/${g}/messages`, as, { params: p }),
    roster: (as: Person) => call(participantsRoute.GET, `/api/mobile/chat/groups/${g}/participants`, as, { params: p }),
    send: (as: Person, content = `on my way ${testId("m")}`) =>
      call(messagesRoute.POST, `/api/mobile/chat/groups/${g}/messages`, as, { method: "POST", body: { content }, params: p }),
    react: (as: Person) =>
      call(reactionsRoute.POST, `/api/mobile/chat/groups/${g}/messages/${w.messageId}/reactions`, as, {
        method: "POST",
        body: { emoji: "👍" },
        params: { chatGroupId: g, messageId: w.messageId },
      }),
    reportMessage: (as: Person) =>
      call(messageReportRoute.POST, `/api/mobile/messages/${w.messageId}/report`, as, {
        method: "POST",
        body: { messageType: "group", reason: "spam" },
        params: { messageId: w.messageId },
      }),
    reportRoom: (as: Person) =>
      call(roomReportRoute.POST, `/api/mobile/chat/groups/${g}/report`, as, { method: "POST", body: { reason: "spam" }, params: p }),
    mute: (as: Person) => call(muteRoute.POST, `/api/mobile/chat/groups/${g}/mute`, as, { method: "POST", body: {}, params: p }),
    unmute: (as: Person) => call(muteRoute.DELETE, `/api/mobile/chat/groups/${g}/mute`, as, { method: "DELETE", params: p }),
    leave: (as: Person) => call(leaveRoute.POST, `/api/mobile/chat/groups/${g}/leave`, as, { method: "POST", params: p }),
    rejoin: (as: Person) => call(leaveRoute.DELETE, `/api/mobile/chat/groups/${g}/leave`, as, { method: "DELETE", params: p }),
  }
}

/* -------------------------------------------------------------------------- */
/* The real socket server                                                      */
/* -------------------------------------------------------------------------- */

const httpServer = createServer()
const io = initSocketServer(httpServer)
const clients: ClientSocket[] = []

interface Heard {
  message: { message: { userId: string; content: string } }[]
  typing: { userId: string; userName: string }[]
  banned: { userId: string; banned: boolean }[]
  left: { userId: string }[]
  muted: { userId: string; muted: boolean }[]
  refused: unknown[]
}

async function online(p: Person) {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, { auth: { token: p.token }, transports: ["websocket"], reconnection: false })
  clients.push(socket)
  const heard: Heard = { message: [], typing: [], banned: [], left: [], muted: [], refused: [] }
  socket.on("chat:message", (m) => heard.message.push(m))
  socket.on("chat:typing", (m) => heard.typing.push(m))
  socket.on("chat:memberBanned", (m) => heard.banned.push(m))
  socket.on("chat:memberLeft", (m) => heard.left.push(m))
  socket.on("chat:memberMuted", (m) => heard.muted.push(m))
  socket.on("error", (e) => heard.refused.push(e))
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve())
    socket.on("connect_error", reject)
  })
  return { socket, heard, id: p.id }
}
type Online = Awaited<ReturnType<typeof online>>

const inRoom = async (chatGroupId: string, userId: string) =>
  (await io.in(`chat:${chatGroupId}`).fetchSockets()).some((s) => s.data.userId === userId)

async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 25) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

/** `join:chat` through the server's own handler: in the room, or refused with FORBIDDEN. */
async function joins(c: Online, chatGroupId: string): Promise<boolean> {
  const before = c.heard.refused.length
  c.socket.emit("join:chat", chatGroupId)
  await until(async () => c.heard.refused.length > before || (await inRoom(chatGroupId, c.id)))
  return inRoom(chatGroupId, c.id)
}

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
})

afterAll(async () => {
  for (const c of clients) c.close()
  stopSponsoredScheduler()
  globalThis.__blendnSocketIo = null
  await new Promise<void>((resolve) => io.close(() => resolve()))
  if (orgs.length) {
    await db.events.updateMany({ where: { organizer_org_id: { in: orgs } }, data: { organizer_org_id: null } })
    await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  }
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await cleanup(users, events)
  if (orgs.length) await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

/* -------------------------------------------------------------------------- */

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
    // A crew or Blend room without its owner is refused (crews.itest.ts and
    // blends.itest.ts prove those arms).
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

  it("will not delete a post that has a room: the room is kept evidence (E1, RESTRICT)", async () => {
    await expect(db.board_posts.delete({ where: { id: postA } })).rejects.toThrow(/23001|chat_groups_board_post_id_fkey|Foreign key/)
    expect(await db.board_posts.count({ where: { id: postA } })).toBe(1)
  })

  it("a room made the old way is an event's room", async () => {
    const host = await person("ck-db-old")
    const e = await makeEvent(host.id)
    events.push(e)
    const g = await db.chat_groups.create({ data: { event_id: e, name: "old way" }, select: { kind: true } })
    expect(g.kind).toBe("event")
  })
})

describe("every caller × every operation on a board post's room (SEC-01)", () => {
  let w: World
  let o: ReturnType<typeof ops>

  beforeAll(async () => {
    w = await world("mx")
    o = ops(w)
  }, 60_000)

  it("answers each caller as the owner says, over HTTP and the socket join", async () => {
    const P = w.people
    const callers = { ...P }
    const matrix: Record<string, Record<string, number | boolean | string>> = {}
    for (const [name, who] of Object.entries(callers)) {
      const c = await online(who).catch(() => null)
      matrix[name] = {
        read: (await o.read(who)).status,
        roster: (await o.roster(who)).status,
        send: (await o.send(who)).status,
        react: (await o.react(who)).status === 403 ? 403 : 200,
        reportMessage: (await o.reportMessage(who)).status,
        mute: (await o.mute(who)).status,
        unmute: (await o.unmute(who)).status,
        join: c ? await joins(c, w.groupId) : "handshake refused",
        // The guard itself, as a dashboard socket's join:chat asks it.
        door: await canJoinChat(who.id, w.groupId),
      }
    }
    const refused = { read: 403, roster: 403, send: 403, react: 403, reportMessage: 404, mute: 404, unmute: 404, join: false, door: false }
    const member = { read: 200, roster: 200, send: 201, react: 200, reportMessage: 201, mute: 200, unmute: 200, join: true, door: true }
    // Staff have the dashboard: the attendee socket refuses them at the handshake
    // (SCRUM-198), and the room refuses them as nobody it admits.
    const staff = { ...refused, join: "handshake refused" }
    expect(matrix).toEqual({
      author: member,
      accepted: member,
      // The row exists; the owner does not stand behind it.
      pending: refused,
      stranger: refused,
      elsewhere: refused,
      admin: staff,
      // canOperate on the event, and no seat in its board post's room.
      host: staff,
      // In the event's room, never in this one.
      sameEvent: refused,
      // A ban and a leave are the member row's: refused to read and write, may still report what they saw.
      banned: { ...refused, reportMessage: 201, mute: 200, unmute: 200 },
      left: { ...refused, reportMessage: 201, mute: 200, unmute: 200 },
      // A mute silences and does not banish.
      muted: { ...member, send: 403, react: 403 },
      // An auto-mute whose hour is up lifts on the next send (the door admits them).
      automuted: member,
    })
  })

  it("lists only the people its owner admits on the roster", async () => {
    const roster = await o.roster(w.people.author)
    const ids = (roster.body.data.participants as { userId: string }[]).map((p) => p.userId)
    const named = ids.map((id) => (id === w.people.author.id ? id : roomMemberFromRef(w.scope, id, w.people.author.id)))
    // Active rows of the author, the accepted asker and the auto-muted-then-lifted one; never the pending asker's.
    expect(named).toContain(w.people.author.id)
    expect(named).toContain(w.people.accepted.id)
    expect(named).not.toContain(w.people.pending.id)
  })

  it("never lifts an auto-mute for somebody the owner no longer admits (the door runs first)", async () => {
    await db.board_requests.updateMany({ where: { post_id: w.postId, from_user_id: w.people.automuted.id }, data: { status: "withdrawn" } })
    // Their auto-mute has expired; were the door second, this send would unmute them on the way to a 403.
    // (Reset by the matrix above, so mute them again.)
    await db.chat_group_members.updateMany({
      where: { chat_group_id: w.groupId, user_id: w.people.automuted.id },
      data: { status: "muted", muted_at: new Date(Date.now() - 2 * 60 * 60_000), muted_by: null },
    })
    expect((await o.send(w.people.automuted)).status).toBe(403)
    const row = await db.chat_group_members.findFirstOrThrow({ where: { chat_group_id: w.groupId, user_id: w.people.automuted.id } })
    expect(row.status).toBe("muted")
  })

  it("leaves and rejoins as an accepted asker, and tells the room by a handle scoped to it", async () => {
    const author = await online(w.people.author)
    expect(await joins(author, w.groupId)).toBe(true)
    // The leave tells nobody when it cannot read blocks; if that happens, fail with its own error.
    const errors = jest.spyOn(logger, "error").mockImplementation(() => undefined)
    try {
      expect((await o.leave(w.people.accepted)).status).toBe(200)
      const told = await until(() => author.heard.left.length > 0, 10_000)
      expect(errors.mock.calls).toEqual([])
      expect(told).toBe(true)
    } finally {
      errors.mockRestore()
    }
    const ref = author.heard.left[0].userId
    expect(roomMemberFromRef(w.scope, ref, w.people.author.id)).toBe(w.people.accepted.id)
    expect(roomMemberFromRef(w.eventId, ref, w.people.author.id)).toBeNull()
    expect((await o.read(w.people.accepted)).status).toBe(403)
    expect((await o.rejoin(w.people.accepted)).body.data).toEqual({ chatGroupId: w.groupId, left: false })
    expect((await o.read(w.people.accepted)).status).toBe(200)
  })

  it("files a room report only for an event's room; a board room's messages are reported one by one", async () => {
    expect((await o.reportRoom(w.people.accepted)).status).toBe(404)
    expect(await db.event_reports.count({ where: { chat_group_id: w.groupId } })).toBe(0)
    expect(await db.message_reports.count({ where: { message_id: w.messageId, reporter_id: w.people.accepted.id } })).toBe(1)
  })
})

describe("a room its owner closes stops reaching the people in it (E3, E4)", () => {
  async function joinedWorld(label: string) {
    const w = await world(label)
    const author = await online(w.people.author)
    const asker = await online(w.people.accepted)
    expect(await joins(author, w.groupId)).toBe(true)
    expect(await joins(asker, w.groupId)).toBe(true)
    return { w, o: ops(w), author, asker }
  }

  it("a withdrawn post: out of the room, no further messages, refused at the door", async () => {
    const { w, o, asker } = await joinedWorld("cl-wd")
    const before = `before the takedown ${testId("k")}`
    expect((await o.send(w.people.author, before)).status).toBe(201)
    expect(await until(() => asker.heard.message.some((m) => m.message.content === before))).toBe(true)
    const withdraw = await call(withdrawRoute.DELETE, `/api/mobile/events/${w.eventId}/board/${w.postId}`, w.people.author, {
      method: "DELETE",
      params: { eventId: w.eventId, postId: w.postId },
    })
    expect(withdraw.status).toBe(200)
    expect(await until(async () => !(await inRoom(w.groupId, w.people.accepted.id)))).toBe(true)
    // A late emit — the moderation pipeline's, say — reaches nobody the owner no longer admits.
    emitChatMessage(w.groupId, { id: "late", content: "after the takedown", type: "text", userId: w.people.author.id, userName: "x", createdAt: new Date().toISOString() })
    await new Promise((r) => setTimeout(r, 300))
    expect(asker.heard.message.filter((m) => m.message.content === "after the takedown")).toEqual([])
    expect((await o.read(w.people.accepted)).status).toBe(404)
    expect((await o.send(w.people.author)).status).toBe(403)
    expect(await joins(asker, w.groupId)).toBe(false)
  })

  it("an ask undone, and a block between author and asker: each refused at every door, and dropped from delivery", async () => {
    const { w, o, author, asker } = await joinedWorld("cl-ask")
    await db.board_requests.update({ where: { id: w.acceptedAskId }, data: { status: "declined" } })
    const content = `still here ${testId("k")}`
    expect((await o.send(w.people.author, content)).status).toBe(201)
    // Delivered (the author hears it), and not to the asker the owner no longer admits.
    expect(await until(() => author.heard.message.some((m) => m.message.content === content))).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
    expect(asker.heard.message.filter((m) => m.message.content === content)).toEqual([])
    expect(await inRoom(w.groupId, w.people.accepted.id)).toBe(false)
    expect((await o.read(w.people.accepted)).status).toBe(403)
    expect(await joins(asker, w.groupId)).toBe(false)

    // E4: accepted again, then a block either way closes the room for the pair.
    await db.board_requests.update({ where: { id: w.acceptedAskId }, data: { status: "accepted" } })
    expect(await joins(asker, w.groupId)).toBe(true)
    await db.blocked_users.create({ data: { blocker_id: w.people.accepted.id, blocked_id: w.people.author.id } })
    expect((await o.read(w.people.accepted)).status).toBe(404)
    expect(await canJoinChat(w.people.accepted.id, w.groupId)).toBe(false)
    const after = `after the block ${testId("k")}`
    expect((await o.send(w.people.author, after)).status).toBe(201)
    expect(await until(() => author.heard.message.some((m) => m.message.content === after))).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
    expect(asker.heard.message.filter((m) => m.message.content === after)).toEqual([])
    // The author's room goes on.
    expect((await o.read(w.people.author)).status).toBe(200)
  })

  it("a hidden event, a lock and an archive", async () => {
    const { w, o, asker } = await joinedWorld("cl-state")
    await db.chat_groups.update({ where: { id: w.groupId }, data: { status: "locked" } })
    expect((await o.send(w.people.author)).body.errorCode).toBe("CHAT_LOCKED")
    expect((await o.read(w.people.accepted)).status).toBe(200)
    await db.chat_groups.update({ where: { id: w.groupId }, data: { status: "archived" } })
    expect((await o.send(w.people.author)).body.errorCode).toBe("CHAT_CLOSED")
    await db.chat_groups.update({ where: { id: w.groupId }, data: { status: "active" } })

    await db.events.update({ where: { id: w.eventId }, data: { status: "draft" } })
    expect((await o.read(w.people.accepted)).status).toBe(404)
    expect((await o.send(w.people.author)).status).toBe(403)
    asker.socket.emit("leave:chat", w.groupId)
    await until(async () => !(await inRoom(w.groupId, w.people.accepted.id)))
    expect(await joins(asker, w.groupId)).toBe(false)
  })

  it("ban, mute and leave notices name people by a handle scoped to the room, found through the lookup", async () => {
    const { w, author, asker } = await joinedWorld("cl-notice")
    // No scope passed: `toChatRoom` looks the room up and mints in its own scope.
    emitChatMemberMuted(w.groupId, w.people.accepted.id, true, "Muted by the author")
    expect(await until(() => author.heard.muted.length > 0)).toBe(true)
    expect(roomMemberFromRef(w.scope, author.heard.muted[0].userId, w.people.author.id)).toBe(w.people.accepted.id)
    expect(resolveUserRef(author.heard.muted[0].userId)).toBeNull()

    emitChatMemberBanned(w.groupId, w.people.accepted.id, true)
    expect(await until(() => author.heard.banned.length > 0 && asker.heard.banned.length > 0)).toBe(true)
    // The banned person hears their own real id; the room hears the room's handle.
    expect(asker.heard.banned[0].userId).toBe(w.people.accepted.id)
    expect(roomMemberFromRef(w.scope, author.heard.banned[0].userId, w.people.author.id)).toBe(w.people.accepted.id)
    expect(await until(async () => !(await inRoom(w.groupId, w.people.accepted.id)))).toBe(true)
  })

  it("the sweeper archives a board room twelve hours after its event, and takes its people out (E2)", async () => {
    const { w, asker } = await joinedWorld("cl-clock")
    const fresh = await world("cl-clock-fresh")
    await db.events.update({ where: { id: w.eventId }, data: { end_time: new Date(Date.now() - 13 * 60 * 60_000) } })
    await db.events.update({ where: { id: fresh.eventId }, data: { end_time: new Date(Date.now() - 11 * 60 * 60_000) } })
    for (let pass = 0; pass < 20 && (await sweepExpiredChats()).hasMore; pass++);
    const rooms = await db.chat_groups.findMany({ where: { id: { in: [w.groupId, fresh.groupId] } }, select: { id: true, status: true } })
    expect(Object.fromEntries(rooms.map((g) => [g.id, g.status]))).toEqual({ [w.groupId]: "archived", [fresh.groupId]: "active" })
    expect(await until(async () => !(await inRoom(w.groupId, w.people.accepted.id)))).toBe(true)
    expect(asker.socket.connected).toBe(true)
    // Past its clock, refused on the clock even before any sweep: the fresh one is open, this one is not.
    expect((await ops(w).send(w.people.author)).body.errorCode).toBe("CHAT_CLOSED")
  })
})

describe("typing in a room the door has closed reaches nobody", () => {
  it("is silenced for a pending asker, and in an event room once its event is a draft", async () => {
    const w = await world("ty")
    const author = await online(w.people.author)
    const pending = await online(w.people.pending)
    const accepted = await online(w.people.accepted)
    expect(await joins(author, w.groupId)).toBe(true)

    pending.socket.emit("chat:startTyping", w.groupId)
    accepted.socket.emit("chat:startTyping", w.groupId)
    expect(await until(() => author.heard.typing.length > 0)).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(author.heard.typing.map((t) => roomMemberFromRef(w.scope, t.userId, w.people.author.id))).toEqual([w.people.accepted.id])

    // The event's room: typing reaches it, until the event is hidden.
    const sameEvent = await online(w.people.sameEvent)
    expect(await joins(author, w.eventRoomId)).toBe(true)
    sameEvent.socket.emit("chat:startTyping", w.eventRoomId)
    expect(await until(() => author.heard.typing.length > 1)).toBe(true)
    await db.events.update({ where: { id: w.eventId }, data: { status: "draft" } })
    const before = author.heard.typing.length
    sameEvent.socket.emit("chat:startTyping", w.eventRoomId)
    await new Promise((r) => setTimeout(r, 400))
    expect(author.heard.typing.length).toBe(before)
  })
})

describe("a board room's handle names nobody outside it (CR-I12, SEC-06)", () => {
  let w: World
  let authorRef: string

  beforeAll(async () => {
    w = await world("h")
    const history = await ops(w).read(w.people.accepted)
    authorRef = (history.body.data.messages as { content: string; user: { id: string } }[]).find((m) => m.content === "leaving at 7")!.user.id
  }, 60_000)

  it("resolves in this room only", () => {
    expect(authorRef).not.toBe(w.people.author.id)
    expect(roomMemberFromRef(w.scope, authorRef, w.people.accepted.id)).toBe(w.people.author.id)
    expect(roomMemberFromRef(w.eventId, authorRef, w.people.accepted.id)).toBeNull()
    expect(resolveUserRef(authorRef)).toBeNull()
  })

  it("an event's wave refuses it, where the event room's own handle for the same person goes through", async () => {
    const wave = (ref: string) =>
      call(wavesRoute.POST, `/api/mobile/events/${w.eventId}/waves`, w.people.accepted, {
        method: "POST",
        body: { toUserId: ref },
        params: { eventId: w.eventId },
      })
    // Answered as somebody not in the room — which the author, checked in, is.
    const refused = await wave(authorRef)
    expect([refused.status, refused.body.errorCode]).toEqual([403, "RECIPIENT_NOT_HERE"])
    expect([200, 201]).toContain((await wave(roomHandle(w.eventId, w.people.author.id))).status)
  })

  it("every route that takes a person answers it exactly as an id nobody has", async () => {
    const nobody = `cnobody${testId("x").replace(/[^a-z0-9]/g, "")}`
    const asker = w.people.sameEvent
    const routes = {
      like: (ref: string) =>
        call(likesRoute.POST, `/api/mobile/events/${w.eventId}/matches/likes`, asker, { method: "POST", body: { userId: ref }, params: { eventId: w.eventId } }),
      user: (ref: string) => call(userRoute.GET, `/api/mobile/users/${ref}`, asker, { params: { userId: ref } }),
      profile: (ref: string) => call(profileRoute.GET, `/api/mobile/profiles/${ref}`, asker, { params: { userId: ref } }),
      report: (ref: string) =>
        call(userReportRoute.POST, `/api/mobile/users/${ref}/report`, asker, { method: "POST", body: { reason: "spam" }, params: { userId: ref } }),
      block: (ref: string) => call(blockRoute.POST, `/api/mobile/users/${ref}/block`, asker, { method: "POST", params: { userId: ref } }),
      messageRequest: (ref: string) =>
        call(requestsRoute.POST, "/api/mobile/message-requests", asker, { method: "POST", body: { recipientId: ref, message: "hi" } }),
    }
    const answers: Record<string, [number, number]> = {}
    for (const [name, route] of Object.entries(routes)) answers[name] = [(await route(authorRef)).status, (await route(nobody)).status]
    for (const [name, [board, unknown]] of Object.entries(answers)) expect({ name, board }).toEqual({ name, board: unknown })
    // Nothing was written about the author through it: block and report go through the board's own routes.
    expect(await db.blocked_users.count({ where: { blocker_id: asker.id } })).toBe(0)
    expect(await db.user_reports.count({ where: { reporter_id: asker.id } })).toBe(0)
  })

  it("lists only event rooms in /chat/groups, and never 500s for a member of both (CR-I02)", async () => {
    const list = await call(chatListRoute.GET, "/api/mobile/chat/groups", w.people.accepted)
    expect(list.status).toBe(200)
    const ids = (list.body.data.groups as { id: string }[]).map((g) => g.id)
    expect(ids).not.toContain(w.groupId)
    expect(ids).toContain(w.eventRoomId)
  })
})

describe("the chat sweeper closes event rooms by their event (CR-I02)", () => {
  it("archives an ended event's room and leaves a board post room on a live event alone", async () => {
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
    const live = await liveEvent(host.id)
    const post = await db.board_posts.create({ data: { event_id: live, author_id: host.id, kind: "chat", body: "after" } })
    const postRoom = await db.chat_groups.create({ data: { kind: "board_post", board_post_id: post.id, name: "after", status: "active" } })

    for (let pass = 0; pass < 20 && (await sweepExpiredChats()).hasMore; pass++);

    const after = await db.chat_groups.findMany({ where: { id: { in: [eventRoom.id, postRoom.id] } }, select: { id: true, status: true } })
    expect(Object.fromEntries(after.map((g) => [g.id, g.status]))).toEqual({ [eventRoom.id]: "archived", [postRoom.id]: "active" })
  })
})
