process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"

import { scheduleLiveEnd } from "@/lib/live-timers"
import { expireWindows } from "@/lib/presence-sweeper"
import { canJoinChat, canJoinEvent, canJoinEventRoom } from "@/lib/socket-auth"
import { guardJoin, type AuthenticatedSocket } from "@/lib/socket-server"

import { closeDb, db } from "./helpers"
import {
  checkInOf,
  cleanupWorld,
  goLive,
  groupParams,
  openSessionOf,
  person,
  req,
  rewind,
  routes,
  sessionOf,
  until,
  venue,
} from "./go-live-world"

/**
 * A venue day's room, over real sockets (step 4 review): a window's end takes
 * the person out of the room at its second, tells them, and nothing from the
 * room reaches them after — whether or not the eviction has run yet.
 *
 * A real socket.io server installed as the app's `io`, joins through the real
 * `guardJoin` and the real join rules, messages and arrivals through the real
 * routes.
 */

const httpServer = createServer()
const io = new Server(httpServer)
const clients: ClientSocket[] = []

io.on("connection", (socket) => {
  const userId = String(socket.handshake.auth.userId)
  socket.data.userId = userId
  socket.join(`user:${userId}`)
  const s = socket as unknown as AuthenticatedSocket
  socket.on("join:chat", (id: string) => void guardJoin(s, `chat:${id}`, "Not authorized to join this chat", () => canJoinChat(userId, id)))
  socket.on("join:event:room", (id: string) => void guardJoin(s, `event:room:${id}`, "Check in to see who else is here", () => canJoinEventRoom(userId, id)))
  socket.on("join:event", (id: string) => void guardJoin(s, `event:${id}`, "Not authorized to join this event", () => canJoinEvent(userId, id)))
})

/** A connected phone, and everything it hears. */
async function phone(userId: string) {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, { auth: { userId }, transports: ["websocket"], reconnection: false })
  clients.push(socket)
  const heard: Array<{ event: string; payload: Record<string, unknown> }> = []
  socket.onAny((event: string, payload: Record<string, unknown>) => heard.push({ event, payload }))
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
  return { socket, heard, of: (event: string) => heard.filter((h) => h.event === event) }
}

/** Join, and wait until the server has put the socket in (or refused it). */
async function join(p: Awaited<ReturnType<typeof phone>>, kind: "chat" | "event:room" | "event", id: string) {
  const room = kind === "chat" ? `chat:${id}` : kind === "event:room" ? `event:room:${id}` : `event:${id}`
  const errorsBefore = p.of("error").length
  p.socket.emit(`join:${kind}`, id)
  await until(
    async () => (await io.in(room).fetchSockets()).some((s) => s.id === p.socket.id) || p.of("error").length > errorsBefore,
    (done) => done
  )
  return (await io.in(room).fetchSockets()).some((s) => s.id === p.socket.id)
}

const quiet = () => new Promise((r) => setTimeout(r, 400))

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  globalThis.__blendnSocketIo = io as typeof globalThis.__blendnSocketIo
})

afterAll(async () => {
  for (const c of clients) c.close()
  await new Promise<void>((resolve) => io.close(() => resolve()))
  globalThis.__blendnSocketIo = null
  await cleanupWorld()
  await closeDb()
}, 120_000)

async function twoLive() {
  const v = await venue()
  const [a, b] = [await person("gla"), await person("glb")]
  const liveA = await goLive(a.token, v)
  await goLive(b.token, v)
  const dayId = liveA.json.data.venueDayId as string
  const groupId = liveA.json.data.chatGroupId as string
  await Promise.all([openSessionOf(dayId, a.id), openSessionOf(dayId, b.id)])
  const [pa, pb] = [await phone(a.id), await phone(b.id)]
  for (const p of [pa, pb]) {
    expect(await join(p, "chat", groupId)).toBe(true)
    expect(await join(p, "event:room", dayId)).toBe(true)
    expect(await join(p, "event", dayId)).toBe(true)
  }
  return { v, a, b, pa, pb, dayId, groupId }
}

const post = (token: string, groupId: string, content: string) =>
  routes.messages.POST(req(`/api/mobile/chat/groups/${groupId}/messages`, token, "POST", { content }), groupParams(groupId))

it("stops the room reaching somebody whose window ended, before and after they are taken out", async () => {
  const { v, a, b, pa, pb, dayId, groupId } = await twoLive()

  // Live: a message reaches both.
  expect((await post(b.token, groupId, "first")).status).toBe(201)
  await until(async () => pa.of("chat:message").length, (n) => n === 1)
  expect(pa.of("chat:message")).toHaveLength(1)

  // a's window ends; nothing has swept it yet, and a's socket is still in the room.
  await rewind(dayId, a.id, 25)
  expect((await io.in(`chat:${groupId}`).fetchSockets()).some((s) => s.id === pa.socket.id)).toBe(true)
  expect((await post(b.token, groupId, "second")).status).toBe(201)
  await until(async () => pb.of("chat:message").length, (n) => n === 2)
  await quiet()
  expect(pa.of("chat:message")).toHaveLength(1)

  // The sweep (or the timer) ends it: told, and taken out of every room.
  await expireWindows()
  await until(async () => pa.of("live:ended").length, (n) => n === 1)
  expect(pa.of("live:ended")[0].payload).toEqual({ eventId: dayId, reason: "expired" })
  for (const room of [`chat:${groupId}`, `event:room:${dayId}`, `event:${dayId}`]) {
    expect((await io.in(room).fetchSockets()).some((s) => s.id === pa.socket.id)).toBe(false)
  }
  expect((await sessionOf(dayId, a.id)).departed_source).toBe("expired")

  // Nothing more from the room: not a message, not an arrival.
  const c = await person("glc")
  await goLive(c.token, v)
  await until(async () => pb.of("event:room:checkin").length, (n) => n >= 1)
  expect((await post(b.token, groupId, "third")).status).toBe(201)
  await until(async () => pb.of("chat:message").length, (n) => n === 3)
  await quiet()
  expect(pa.of("chat:message")).toHaveLength(1)
  expect(pa.of("event:room:checkin")).toHaveLength(0)
  expect(pa.of("event:checkin")).toHaveLength(0)

  // And it cannot come back in.
  expect(await join(pa, "chat", groupId)).toBe(false)
  expect(await join(pa, "event:room", dayId)).toBe(false)
  expect(await join(pa, "event", dayId)).toBe(false)
  expect(pa.of("error").length).toBeGreaterThanOrEqual(3)
})

it("ends a window at its second with the timer, not at the next sweep", async () => {
  const { a, pa, dayId } = await twoLive()
  const row = await checkInOf(dayId, a.id)
  const soon = new Date(Date.now() + 300)
  await db.event_check_ins.update({ where: { id: row.id }, data: { expires_at: soon } })
  scheduleLiveEnd(row.id, soon)
  await until(async () => pa.of("live:ended").length, (n) => n === 1, 4_000)
  expect(pa.of("live:ended")).toHaveLength(1)
  expect((await checkInOf(dayId, a.id)).status).toBe("checked_out")
  expect((await sessionOf(dayId, a.id)).departed_source).toBe("expired")
})

it("does not announce an arrival when somebody live goes live again", async () => {
  const { v, a, pb } = await twoLive()
  const before = pb.of("event:room:checkin").length
  await goLive(a.token, v, { minutes: 60 })
  await quiet()
  expect(pb.of("event:room:checkin").length).toBe(before)
  // A real arrival still is.
  const c = await person("glc")
  await goLive(c.token, v)
  await until(async () => pb.of("event:room:checkin").length, (n) => n === before + 1)
  expect(pb.of("event:room:checkin").length).toBe(before + 1)
})
