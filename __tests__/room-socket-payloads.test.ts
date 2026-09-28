/*
 * What the Room redesign reads off the socket.
 *
 * The mobile Room keeps its headline number live from `hereCount` on the
 * check-in and checkout events — so the number must be on all three payloads,
 * and must be "inside now" (`hereCountFor`), so a checkout brings it down. `room:match` and
 * `room:wave` go to a person's own `user:{id}` room and nowhere else.
 *
 * And every id on them is per recipient (SCRUM-371): your own is your real id,
 * anybody else's is their handle in this event, resolving back to them.
 *
 * A real socket.io server installed as the app's `io`, as in
 * `dm-delivered-once.test.ts`, because the failure modes here are delivery
 * failures: a key missing on the wire, or a payload reaching the wrong room.
 */
process.env.NEXTAUTH_SECRET = "room-socket-payloads-secret-32-characters"
const mockFindMany = jest.fn()
const mockChatGroup = jest.fn()
jest.mock("@/lib/db", () => ({
  db: {
    event_check_ins: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    chat_groups: { findUnique: (...a: unknown[]) => mockChatGroup(...a) },
  },
}))
jest.mock("@/lib/mobile-auth", () => ({ verifyAccessToken: jest.fn(), accountBlockReason: jest.fn() }))

import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import {
  emitChatMemberBanned,
  emitChatMemberMuted,
  emitChatMessage,
  emitChatMessageHidden,
  emitEventCheckIn,
  emitEventCheckOut,
  emitEventInterestUpdate,
  emitRoomMatch,
  emitRoomWave,
} from "@/lib/socket-server"
import { resolveUserRef, roomHandle } from "@/lib/room-handle"

const EVENT = "e0000000-0000-4000-8000-000000000001"
const CHAT = "c0000000-0000-4000-8000-000000000001"
const handle = (userId: string) => roomHandle(EVENT, userId)

const httpServer = createServer()
const io = new Server(httpServer)
const clients: ClientSocket[] = []

io.on("connection", (socket) => {
  const { userId, rooms } = socket.handshake.auth as { userId: string; rooms: string[] }
  // As the auth middleware does: the per-recipient emit reads who each socket is.
  socket.data.userId = userId
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
  mockChatGroup.mockReset()
  mockChatGroup.mockResolvedValue({ event_id: EVENT })
})

describe("hereCount", () => {
  it("rides on event:checkin, event:room:checkin and event:checkout", async () => {
    const watcher = await listen("watcher", [`event:${EVENT}`])
    const inRoom = await listen("in-room", [`event:room:${EVENT}`])

    emitEventCheckIn(EVENT, "arriver", "Cosmic Panda")
    emitEventCheckOut(EVENT, "leaver")
    await settle()

    expect(watcher["event:checkin"]).toEqual([
      expect.objectContaining({ eventId: EVENT, userId: handle("arriver"), hereCount: 7 }),
    ])
    expect(inRoom["event:room:checkin"]).toEqual([
      expect.objectContaining({ userId: handle("arriver"), userName: "Cosmic Panda", hereCount: 7 }),
    ])
    expect(watcher["event:checkout"]).toEqual([expect.objectContaining({ userId: handle("leaver"), hereCount: 7 })])
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

    expect(watcher["event:checkin"]).toEqual([expect.objectContaining({ userId: handle("arriver-2") })])
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

    // The other person as the roster shows them in this event: their handle.
    expect(a["room:match"]).toEqual([
      { eventId: EVENT, otherUserId: handle("user-b"), conversationId: "conv-1", name: "Priya" },
    ])
    expect(b["room:match"]).toEqual([
      { eventId: EVENT, otherUserId: handle("user-a"), conversationId: "conv-1", name: "Cosmic Panda" },
    ])
    expect(bystander["room:match"]).toBeUndefined()
  })

  it("room:wave reaches only the recipient", async () => {
    const to = await listen("wave-to", [])
    const from = await listen("wave-from", [`event:room:${EVENT}`])

    emitRoomWave("wave-to", { eventId: EVENT, fromUserId: "wave-from", fromName: "Cosmic Panda" })
    await settle()

    expect(to["room:wave"]).toEqual([{ eventId: EVENT, fromUserId: handle("wave-from"), fromName: "Cosmic Panda" }])
    expect(from["room:wave"]).toBeUndefined()
  })
})

describe("every recipient gets their own copy (SCRUM-371)", () => {
  /*
   * The threat: a friend holds your real id. Any room payload carrying it next
   * to your pseudonym, or on the counter room anyone may join, tells them which
   * card is you. So each socket's copy names its own reader by their real id —
   * the app aligns its bubbles and spots its own check-in with it — and names
   * everyone else by this event's handle, which resolves back to them.
   */
  const realIdsIn = (seen: Seen, ...ids: string[]) => ids.filter((id) => JSON.stringify(seen).includes(id))

  it("event:checkin and event:room:checkin: the arriver sees themselves, everyone else sees a handle", async () => {
    const arriver = await listen("pr-arriver", [`event:${EVENT}`, `event:room:${EVENT}`])
    const friend = await listen("pr-friend", [`event:${EVENT}`, `event:room:${EVENT}`])
    const stranger = await listen("pr-stranger", [`event:${EVENT}`])

    emitEventCheckIn(EVENT, "pr-arriver", "Cosmic Panda")
    await settle()

    expect(arriver["event:checkin"]).toEqual([expect.objectContaining({ userId: "pr-arriver" })])
    expect(arriver["event:room:checkin"]).toEqual([expect.objectContaining({ userId: "pr-arriver" })])
    for (const other of [friend, stranger]) {
      const [payload] = other["event:checkin"] as { userId: string }[]
      expect(resolveUserRef(payload.userId)).toEqual({ userId: "pr-arriver", eventId: EVENT })
      expect(realIdsIn(other, "pr-arriver")).toEqual([])
    }
    expect(friend["event:room:checkin"]).toEqual([expect.objectContaining({ userId: handle("pr-arriver") })])
  })

  it("event:interestUpdate on the public counter room carries no real id but your own", async () => {
    const me = await listen("pr-interested", [`event:${EVENT}`])
    const watcher = await listen("pr-watcher", [`event:${EVENT}`])

    emitEventInterestUpdate(EVENT, "pr-interested", true, 12)
    await settle()

    expect(me["event:interestUpdate"]).toEqual([expect.objectContaining({ userId: "pr-interested", interestCount: 12 })])
    expect(watcher["event:interestUpdate"]).toEqual([expect.objectContaining({ userId: handle("pr-interested") })])
  })

  it("chat:message: the sender's own sockets see their id, the room sees a handle, the blocked see nothing", async () => {
    const senderPhone = await listen("pr-sender", [`chat:${CHAT}`])
    const senderTablet = await listen("pr-sender", [`chat:${CHAT}`])
    const reader = await listen("pr-reader", [`chat:${CHAT}`])
    const blocker = await listen("pr-blocker", [`chat:${CHAT}`])

    emitChatMessage(
      CHAT,
      { id: "m1", content: "hi", type: "text", userId: "pr-sender", userName: "Cosmic Panda", createdAt: "2026-09-28T00:00:00Z" },
      ["pr-blocker"]
    )
    await settle()

    for (const own of [senderPhone, senderTablet]) {
      expect(own["chat:message"]).toEqual([expect.objectContaining({ message: expect.objectContaining({ userId: "pr-sender" }) })])
    }
    expect(reader["chat:message"]).toEqual([
      expect.objectContaining({ chatGroupId: CHAT, message: expect.objectContaining({ userId: handle("pr-sender") }) }),
    ])
    expect(realIdsIn(reader, "pr-sender")).toEqual([])
    expect(blocker["chat:message"]).toBeUndefined()
    // The handle is minted from the room's event, not from the chat group id.
    expect(mockChatGroup).toHaveBeenCalledWith({ where: { id: CHAT }, select: { event_id: true } })
  })

  it("event:checkout: the leaver's own socket reads their real id, a watcher a handle", async () => {
    const leaver = await listen("pr-leaver", [`event:${EVENT}`])
    const watcher = await listen("pr-co-watcher", [`event:${EVENT}`])

    emitEventCheckOut(EVENT, "pr-leaver")
    await settle()

    expect(leaver["event:checkout"]).toEqual([expect.objectContaining({ userId: "pr-leaver" })])
    expect(watcher["event:checkout"]).toEqual([expect.objectContaining({ userId: handle("pr-leaver") })])
  })

  it("chat:messageDeleted (moderation): the author reads their own id and draws the placeholder; the room a handle", async () => {
    const author = await listen("pr-hidden-author", [`chat:${CHAT}`])
    const witness = await listen("pr-hidden-witness", [`chat:${CHAT}`])

    emitChatMessageHidden(CHAT, "m-hidden", "pr-hidden-author")
    await settle()

    expect(author["chat:messageDeleted"]).toEqual([
      { chatGroupId: CHAT, messageId: "m-hidden", moderation: true, userId: "pr-hidden-author" },
    ])
    expect(witness["chat:messageDeleted"]).toEqual([
      { chatGroupId: CHAT, messageId: "m-hidden", moderation: true, userId: handle("pr-hidden-author") },
    ])
  })

  it("chat:memberMuted: the muted member reads their own id; the room a handle", async () => {
    const muted = await listen("pr-muted", [`chat:${CHAT}`])
    const witness = await listen("pr-mute-witness", [`chat:${CHAT}`])

    emitChatMemberMuted(CHAT, "pr-muted", true, "Muted by admin")
    await settle()

    expect(muted["chat:memberMuted"]).toEqual([
      { chatGroupId: CHAT, userId: "pr-muted", muted: true, reason: "Muted by admin" },
    ])
    expect(witness["chat:memberMuted"]).toEqual([
      { chatGroupId: CHAT, userId: handle("pr-muted"), muted: true, reason: "Muted by admin" },
    ])
  })

  it("an emitter told the event mints handles from it without looking the room up", async () => {
    const witness = await listen("pr-known-witness", [`chat:${CHAT}`])

    emitChatMessage(
      CHAT,
      { id: "m2", content: "hi", type: "text", userId: "pr-known-sender", userName: "Quiet Otter", createdAt: "2026-09-28T00:00:00Z" },
      [],
      EVENT
    )
    await settle()

    expect(witness["chat:message"]).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ userId: handle("pr-known-sender") }) }),
    ])
    expect(mockChatGroup).not.toHaveBeenCalled()
  })

  it("chat:memberBanned reaches the banned person under their own id, then takes them out of the room", async () => {
    const banned = await listen("pr-banned", [`chat:${CHAT}`])
    const witness = await listen("pr-witness", [`chat:${CHAT}`])

    emitChatMemberBanned(CHAT, "pr-banned", true)
    await settle()

    expect(banned["chat:memberBanned"]).toEqual([{ chatGroupId: CHAT, userId: "pr-banned", banned: true }])
    expect(witness["chat:memberBanned"]).toEqual([{ chatGroupId: CHAT, userId: handle("pr-banned"), banned: true }])
    const inRoom = await io.in(`chat:${CHAT}`).fetchSockets()
    expect(inRoom.map((s) => s.data.userId)).not.toContain("pr-banned")
  })
})
