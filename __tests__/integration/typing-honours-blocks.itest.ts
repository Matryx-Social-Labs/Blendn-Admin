/*
 * A block reaches typing indicators (SCRUM-338).
 *
 * Driven on staging (SCRUM-269): A blocked B in a live room, B started and
 * stopped typing, and A's socket received both `chat:typing` events under B's
 * pseudonym, while B's *message* in the same run correctly never reached A.
 * `emitChatMessage` leaves out a sender's block counterparties; `emitChatTyping`
 * broadcast to the whole room.
 *
 * A real socket.io server and three real clients, with each server-side socket
 * in `chat:<room>` and `user:<id>` as the connection handler puts it, so
 * `except()` is exercised as socket.io applies it. Real rows for the room and
 * the block.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import { emitChatTyping, type AuthenticatedSocket } from "@/lib/socket-server"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
let roomId = ""
let A = ""
let B = ""
let C = ""

const httpServer = createServer()
const io = new Server(httpServer)
const serverSide = new Map<string, AuthenticatedSocket>()
const clients: ClientSocket[] = []

io.on("connection", (socket) => {
  const userId = String(socket.handshake.auth.userId)
  socket.data.userId = userId
  socket.join(`user:${userId}`)
  socket.join(`chat:${roomId}`)
  serverSide.set(userId, socket as unknown as AuthenticatedSocket)
})

async function client(userId: string): Promise<{ typing: unknown[] }> {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, { auth: { userId }, transports: ["websocket"] })
  clients.push(socket)
  const seen = { typing: [] as unknown[] }
  socket.on("chat:typing", (p) => seen.typing.push(p))
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
  return seen
}

const settle = () => new Promise((r) => setTimeout(r, 150))

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  A = await makeUser(testId("thb-a"))
  B = await makeUser(testId("thb-b"))
  C = await makeUser(testId("thb-c"))
  const host = await makeUser(testId("thb-host"), "organizer")
  users.push(A, B, C, host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  roomId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })).id
  for (const [id, name] of [[A, "Quiet Otter"], [B, "Hidden Dune"], [C, "Amber Fox"]]) {
    await db.chat_group_members.create({ data: { chat_group_id: roomId, user_id: id, status: "active", anonymous_name: testId(name) } })
  }
})

afterAll(async () => {
  for (const c of clients) c.close()
  await new Promise<void>((resolve) => io.close(() => resolve()))
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await cleanup(users, events)
  await closeDb()
})

it("the blocker never sees the blocked person typing, whoever filed the block; everyone else does", async () => {
  const [a, b, c] = [await client(A), await client(B), await client(C)]
  await db.blocked_users.create({ data: { blocker_id: A, blocked_id: B } })

  // B types: A blocked B.
  await emitChatTyping(serverSide.get(B)!, roomId, true)
  await settle()
  expect(a.typing).toHaveLength(0)
  expect(c.typing).toEqual([expect.objectContaining({ userId: B, isTyping: true })])
  expect(b.typing).toHaveLength(0) // never to yourself

  // A types: the block is symmetric in effect, so B must not see A either.
  await emitChatTyping(serverSide.get(A)!, roomId, true)
  await settle()
  expect(b.typing).toHaveLength(0)
  expect(c.typing).toHaveLength(2)
})

it("an unblocked room still hears everyone", async () => {
  await db.blocked_users.deleteMany({ where: { blocker_id: A, blocked_id: B } })
  const a = await client(A)
  await emitChatTyping(serverSide.get(B)!, roomId, false)
  await settle()
  expect(a.typing).toEqual([expect.objectContaining({ userId: B, isTyping: false })])
})
