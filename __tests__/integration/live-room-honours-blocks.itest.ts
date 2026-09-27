import { NextRequest } from "next/server"

/*
 * A block reaches the live room: typing, and the roster's "just arrived"
 * (SCRUM-338).
 *
 * Driven on staging (SCRUM-269): A blocked B in a live room, B started and
 * stopped typing, and A's socket received both `chat:typing` events under B's
 * pseudonym — while B's *message* in the same run correctly never reached A.
 * The security review of the fix found the same gap one event over: B checking
 * in sent `event:room:checkin` with B's pseudonym to A, although the push for
 * that arrival and the REST roster both already leave B out.
 *
 * A real socket.io server, installed as the app's `io`, and real clients whose
 * server-side sockets sit in `user:<id>`, `chat:<room>` and `event:room:<id>` as
 * the connection handler and the join guards put them. Check-ins go through
 * the real route; real rows throughout.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import { signAccessToken } from "@/lib/mobile-auth"
import { emitChatTyping, type AuthenticatedSocket } from "@/lib/socket-server"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkin = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")

const LAT = 12.9716
const LNG = 77.5946
const users: string[] = []
const events: string[] = []
let eventId = ""
let roomId = ""

const httpServer = createServer()
const io = new Server(httpServer)
const serverSide = new Map<string, AuthenticatedSocket>()
const clients: ClientSocket[] = []

io.on("connection", (socket) => {
  const userId = String(socket.handshake.auth.userId)
  socket.data.userId = userId
  socket.join([`user:${userId}`, `chat:${roomId}`, `event:room:${eventId}`])
  serverSide.set(userId, socket as unknown as AuthenticatedSocket)
})

type Seen = { typing: { userId: string; isTyping: boolean }[]; arrivals: { userId: string }[] }
async function listen(userId: string): Promise<Seen> {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, { auth: { userId }, transports: ["websocket"] })
  clients.push(socket)
  const seen: Seen = { typing: [], arrivals: [] }
  socket.on("chat:typing", (p) => seen.typing.push(p))
  socket.on("event:room:checkin", (p) => seen.arrivals.push(p))
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
  return seen
}

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

const checkIn = async (token: string) => {
  const res = await checkin.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ latitude: LAT, longitude: LNG }),
    }),
    { params: Promise.resolve({ eventId }) }
  )
  expect(res.status).toBe(200)
}

const settle = () => new Promise((r) => setTimeout(r, 200))

let A: { id: string; token: string }
let B: { id: string; token: string }
let C: { id: string; token: string }

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = io

  const host = await makeUser(testId("lrb-host"), "organizer")
  users.push(host)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("lrb"),
      title: "Live room fixture",
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
  eventId = event.id
  events.push(eventId)
  await db.event_occurrences.create({
    data: { event_id: eventId, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })

  A = await person("lrb-a")
  B = await person("lrb-b")
  C = await person("lrb-c")
  // A and C arrive first; the first check-in creates the room.
  await checkIn(A.token)
  await checkIn(C.token)
  roomId = (await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })).id
})

afterAll(async () => {
  for (const c of clients) c.close()
  await new Promise<void>((resolve) => io.close(() => resolve()))
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = null
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.chat_group_members.deleteMany({ where: { user_id: { in: users } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

describe("while A has B blocked", () => {
  let a: Seen, b: Seen, c: Seen
  beforeAll(async () => {
    ;[a, b, c] = [await listen(A.id), await listen(B.id), await listen(C.id)]
    await db.blocked_users.create({ data: { blocker_id: A.id, blocked_id: B.id } })
    await checkIn(B.token)
    await settle()
  })

  it("B's arrival reaches C's roster and not A's", () => {
    expect(c.arrivals.map((x) => x.userId)).toContain(B.id)
    expect(a.arrivals.map((x) => x.userId)).not.toContain(B.id)
  })

  it("neither sees the other type, whoever filed the block; C sees both", async () => {
    await emitChatTyping(serverSide.get(B.id)!, roomId, true)
    await emitChatTyping(serverSide.get(A.id)!, roomId, true)
    await settle()
    expect(a.typing.map((x) => x.userId)).not.toContain(B.id)
    expect(b.typing.map((x) => x.userId)).not.toContain(A.id)
    expect(c.typing.map((x) => x.userId).sort()).toEqual([A.id, B.id].sort())
  })
})

describe("once the block is lifted", () => {
  it("A hears B type again, and hears the next arrival", async () => {
    await db.blocked_users.deleteMany({ where: { blocker_id: A.id, blocked_id: B.id } })
    const a = await listen(A.id)
    await listen(B.id)
    await emitChatTyping(serverSide.get(B.id)!, roomId, false)
    const D = await person("lrb-d")
    await checkIn(D.token)
    await settle()
    expect(a.typing).toEqual([expect.objectContaining({ userId: B.id, isTyping: false })])
    expect(a.arrivals.map((x) => x.userId)).toContain(D.id)
  })
})
