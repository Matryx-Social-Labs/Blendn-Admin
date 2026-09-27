/*
 * What the Room redesign reads off the socket.
 *
 * The mobile Room keeps its headline number live from `hereCount` on the
 * check-in and checkout events — so the number must be on all three payloads,
 * and must be "inside now" (`hereCountFor`), so a checkout brings it down. `room:match` and
 * `room:wave` go to a person's own `user:{id}` room and nowhere else.
 *
 * A real socket.io server installed as the app's `io`, as in
 * `dm-delivered-once.test.ts`, because the failure modes here are delivery
 * failures: a key missing on the wire, or a payload reaching the wrong room.
 */
const mockFindMany = jest.fn()
jest.mock("@/lib/db", () => ({
  db: { event_check_ins: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}))
jest.mock("@/lib/mobile-auth", () => ({ verifyAccessToken: jest.fn(), accountBlockReason: jest.fn() }))

import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import {
  emitEventCheckIn,
  emitEventCheckOut,
  emitRoomMatch,
  emitRoomWave,
} from "@/lib/socket-server"

const EVENT = "e0000000-0000-4000-8000-000000000001"

const httpServer = createServer()
const io = new Server(httpServer)
const clients: ClientSocket[] = []

io.on("connection", (socket) => {
  const { userId, rooms } = socket.handshake.auth as { userId: string; rooms: string[] }
  socket.join([`user:${userId}`, ...rooms])
})

type Seen = Record<string, unknown[]>
async function listen(userId: string, rooms: string[]): Promise<Seen> {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, { auth: { userId, rooms }, transports: ["websocket"] })
  clients.push(socket)
  const seen: Seen = {}
  socket.onAny((name: string, payload: unknown) => {
    ;(seen[name] ??= []).push(payload)
  })
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
  return seen
}

const settle = () => new Promise((r) => setTimeout(r, 150))

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = io
})

afterAll(async () => {
  for (const c of clients) c.close()
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = null
  await new Promise<void>((resolve) => io.close(() => resolve()))
})

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ user_id: `u${i}` }))

beforeEach(() => {
  mockFindMany.mockReset()
  mockFindMany.mockResolvedValue(people(7))
})

describe("hereCount", () => {
  it("rides on event:checkin, event:room:checkin and event:checkout", async () => {
    const watcher = await listen("watcher", [`event:${EVENT}`])
    const inRoom = await listen("in-room", [`event:room:${EVENT}`])

    emitEventCheckIn(EVENT, "arriver", "Cosmic Panda")
    emitEventCheckOut(EVENT, "leaver")
    await settle()

    expect(watcher["event:checkin"]).toEqual([expect.objectContaining({ eventId: EVENT, userId: "arriver", hereCount: 7 })])
    expect(inRoom["event:room:checkin"]).toEqual([
      expect.objectContaining({ userId: "arriver", userName: "Cosmic Panda", hereCount: 7 }),
    ])
    expect(watcher["event:checkout"]).toEqual([expect.objectContaining({ userId: "leaver", hereCount: 7 })])
    // Still no name in the room anyone can join.
    expect(watcher["event:checkin"]![0]).not.toHaveProperty("userName")
  })

  it("counts distinct people inside NOW, so a checkout brings it down", async () => {
    const watcher = await listen("probe", [`event:${EVENT}`])
    mockFindMany.mockResolvedValue(people(6))
    emitEventCheckOut(EVENT, "leaver")
    await settle()

    expect(watcher["event:checkout"]).toEqual([expect.objectContaining({ hereCount: 6 })])
    // Not `distinctAttendeeCounts` (which keeps checked_out): live rows only.
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { event_id: EVENT, status: "checked_in", kind: "attendee", user: { suspended_at: null } },
      distinct: ["user_id"],
      select: { user_id: true },
    })
  })

  it("a failed count still delivers the check-in, without a number, and throws nothing", async () => {
    mockFindMany.mockRejectedValue(new Error("db down"))
    const watcher = await listen("watcher-2", [`event:${EVENT}`])

    expect(() => emitEventCheckIn(EVENT, "arriver-2", "Quiet Otter")).not.toThrow()
    await settle()

    expect(watcher["event:checkin"]).toEqual([expect.objectContaining({ userId: "arriver-2" })])
    expect(watcher["event:checkin"]![0]).not.toHaveProperty("hereCount")
  })
})

describe("room:match and room:wave", () => {
  it("room:match reaches each side with the OTHER person, and nobody else", async () => {
    const a = await listen("user-a", [])
    const b = await listen("user-b", [])
    const bystander = await listen("user-c", [`event:${EVENT}`, `event:room:${EVENT}`])

    emitRoomMatch({
      eventId: EVENT,
      conversationId: "conv-1",
      a: { userId: "user-a", name: "Cosmic Panda" },
      b: { userId: "user-b", name: "Priya" },
    })
    await settle()

    expect(a["room:match"]).toEqual([{ eventId: EVENT, otherUserId: "user-b", conversationId: "conv-1", name: "Priya" }])
    expect(b["room:match"]).toEqual([
      { eventId: EVENT, otherUserId: "user-a", conversationId: "conv-1", name: "Cosmic Panda" },
    ])
    expect(bystander["room:match"]).toBeUndefined()
  })

  it("room:wave reaches only the recipient", async () => {
    const to = await listen("wave-to", [])
    const from = await listen("wave-from", [`event:room:${EVENT}`])

    emitRoomWave("wave-to", { eventId: EVENT, fromUserId: "wave-from", fromName: "Cosmic Panda" })
    await settle()

    expect(to["room:wave"]).toEqual([{ eventId: EVENT, fromUserId: "wave-from", fromName: "Cosmic Panda" }])
    expect(from["room:wave"]).toBeUndefined()
  })
})
