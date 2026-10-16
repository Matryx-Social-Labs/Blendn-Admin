/*
 * A read the server records is told to the conversation.
 *
 * The messages GET (`openThread`) and "Mark all read" set `is_read` and said
 * nothing, so the sender's receipt stayed "Sent" until a reload — only the
 * socket's own `private:read` ever announced a read. And a read is a delivery
 * (SCRUM-408): `delivered_at` is set with it.
 */
const mockDb = {
  private_messages: { findMany: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  profiles: { findUnique: jest.fn() },
  private_conversations: { findUnique: jest.fn(async () => ({ user1_id: "reader", user2_id: "sender", closed_at: null })) },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/mobile-auth", () => ({
  verifyAccessToken: jest.fn(),
  accountBlockReason: jest.fn(),
  getAuthenticatedUser: jest.fn(async () => ({ userId: "reader", email: "r@x" })),
}))
jest.mock("@/lib/rate-limit", () => ({ rateLimit: jest.fn(async () => null), userLimit: jest.fn() }))

import { NextRequest } from "next/server"
import { openThread } from "@/lib/dm-thread"
import { POST as markAllRead } from "@/app/api/mobile/conversations/read/route"
import { emitPrivateRead, type AuthenticatedSocket } from "@/lib/socket-server"

const emitted: Array<{ room: string; event: string; payload: unknown }> = []
const io = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
}
const settle = () => new Promise((r) => setImmediate(r))
const reads = () => emitted.filter((e) => e.event === "private:read")
const delivered = () => emitted.filter((e) => e.event === "private:delivered")
const deliveredWrite = () =>
  mockDb.private_messages.updateMany.mock.calls.find(([arg]) => "delivered_at" in arg.data)?.[0]

beforeAll(() => {
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = io
})
afterAll(() => {
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = null
})
beforeEach(() => {
  jest.clearAllMocks()
  emitted.length = 0
  mockDb.profiles.findUnique.mockResolvedValue({ read_receipts: true })
})

describe("opening a thread", () => {
  beforeEach(() => {
    mockDb.private_messages.findMany
      .mockResolvedValueOnce([{ id: "m1" }, { id: "m2" }]) // unread
      .mockResolvedValueOnce([{ id: "m2" }]) // undelivered
  })

  it("tells the conversation which messages were read, and delivers them", async () => {
    expect(await openThread("c1", "reader")).toEqual({ firstUnreadId: "m1", unreadCount: 2 })
    await settle()
    expect(reads()).toEqual([
      { room: "conversation:c1", event: "private:read", payload: { conversationId: "c1", messageIds: ["m1", "m2"], readBy: "reader" } },
    ])
    expect(delivered().map((e) => e.payload)).toEqual([{ conversationId: "c1", messageIds: ["m2"] }])
    expect(deliveredWrite()).toEqual({
      where: { id: { in: ["m2", "m1"] }, delivered_at: null },
      data: { delivered_at: expect.any(Date) },
    })
  })

  it("records the read but says nothing when the reader has receipts off", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ read_receipts: false })
    await openThread("c1", "reader")
    await settle()
    expect(reads()).toEqual([])
    expect(mockDb.private_messages.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["m1", "m2"] } }, data: { is_read: true } })
  })
})

describe("Mark all read", () => {
  const post = () => markAllRead(new NextRequest("http://x/api/mobile/conversations/read", { method: "POST" }))

  beforeEach(() => {
    mockDb.private_messages.findMany.mockResolvedValueOnce([
      { id: "a1", conversation_id: "ca", delivered_at: null },
      { id: "a2", conversation_id: "ca", delivered_at: new Date() },
      { id: "b1", conversation_id: "cb", delivered_at: new Date() },
    ])
  })

  it("tells each conversation its own reads, and delivers what was not delivered", async () => {
    const res = await post()
    expect((await res.json()).data).toEqual({ marked: 3 })
    await settle()
    expect(reads().map((e) => [e.room, (e.payload as { messageIds: string[] }).messageIds])).toEqual([
      ["conversation:ca", ["a1", "a2"]],
      ["conversation:cb", ["b1"]],
    ])
    expect(delivered().map((e) => e.payload)).toEqual([{ conversationId: "ca", messageIds: ["a1"] }])
    expect(deliveredWrite()).toEqual({
      where: { id: { in: ["a1", "a2", "b1"] }, delivered_at: null },
      data: { delivered_at: expect.any(Date) },
    })
  })

  it("says nothing of the reads when the reader has receipts off", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ read_receipts: false })
    await post()
    await settle()
    expect(reads()).toEqual([])
  })
})

describe("the socket's own read", () => {
  it("counts as delivered, and announces the read once (no second private:read, no private:delivered)", async () => {
    const socketEmits: string[] = []
    const socket = {
      data: { userId: "reader" },
      to: () => ({ emit: (event: string) => socketEmits.push(event) }),
    } as unknown as AuthenticatedSocket
    await emitPrivateRead(socket, "c1", ["m1"])
    expect(deliveredWrite()).toEqual({
      where: { id: { in: ["m1"] }, conversation_id: "c1", sender_id: { not: "reader" }, delivered_at: null },
      data: { delivered_at: expect.any(Date) },
    })
    await settle()
    expect(socketEmits).toEqual(["private:read"])
    expect(emitted).toEqual([])
  })
})
