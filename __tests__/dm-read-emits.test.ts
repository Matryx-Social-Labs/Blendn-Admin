/*
 * A read the server records is told to the conversation.
 *
 * The messages GET (`openThread`) and "Mark all read" set `is_read` and said
 * nothing, so the sender's receipt stayed "Sent" until a reload — only the
 * socket's own `private:read` ever announced a read. And a read is a delivery
 * (SCRUM-408): `delivered_at` is set with it.
 */
const mockDb = {
  private_messages: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
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
import { emitPrivateRead, READ_RECEIPT_BATCH, type AuthenticatedSocket } from "@/lib/socket-server"

const emitted: Array<{ room: string; event: string; payload: unknown }> = []
const io = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
}
const settle = () => new Promise((r) => setImmediate(r))
const reads = () => emitted.filter((e) => e.event === "private:read")
const delivered = () => emitted.filter((e) => e.event === "private:delivered")
const writes = () => mockDb.private_messages.updateMany.mock.calls.map(([arg]) => arg)
const deliveredWrite = () => writes().find((arg) => "delivered_at" in arg.data)
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))

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
  const unreadWhere = { conversation_id: "c1", sender_id: { not: "reader" }, is_read: false }

  beforeEach(() => {
    mockDb.private_messages.findFirst.mockResolvedValue({ id: "m1" })
    mockDb.private_messages.count.mockResolvedValue(2)
    mockDb.private_messages.findMany.mockImplementation(async ({ where }) =>
      where.is_read === false ? [{ id: "m2" }, { id: "m1" }] : [{ id: "m2" }]
    )
  })

  it("tells the conversation which messages were read, and delivers them", async () => {
    expect(await openThread("c1", "reader")).toEqual({ firstUnreadId: "m1", unreadCount: 2 })
    await settle()
    expect(reads()).toEqual([
      { room: "conversation:c1", event: "private:read", payload: { conversationId: "c1", messageIds: ["m2", "m1"], readBy: "reader" } },
    ])
    expect(delivered().map((e) => e.payload)).toEqual([{ conversationId: "c1", messageIds: ["m2"] }])
    // The writes are predicates, never id lists.
    expect(writes()).toEqual([
      { where: expect.objectContaining(unreadWhere), data: { is_read: true } },
      { where: expect.objectContaining({ conversation_id: "c1", delivered_at: null }), data: { delivered_at: expect.any(Date) } },
    ])
  })

  it("records the read but says nothing when the reader has receipts off", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ read_receipts: false })
    await openThread("c1", "reader")
    await settle()
    expect(reads()).toEqual([])
    expect(writes()[0]).toEqual({ where: expect.objectContaining(unreadWhere), data: { is_read: true } })
  })

  it("a backlog of a million is two writes and two emits of at most a batch each", async () => {
    mockDb.private_messages.count.mockResolvedValue(1_000_000)
    mockDb.private_messages.findMany.mockImplementation(async ({ take }) => ids("m", take ?? 1_000_000))
    await openThread("c1", "reader")
    await settle()
    expect(mockDb.private_messages.findMany).toHaveBeenCalledTimes(2)
    for (const [arg] of mockDb.private_messages.findMany.mock.calls) expect(arg.take).toBe(READ_RECEIPT_BATCH)
    expect(mockDb.private_messages.updateMany).toHaveBeenCalledTimes(2)
    expect(emitted).toHaveLength(2)
    for (const e of emitted) expect((e.payload as { messageIds: string[] }).messageIds).toHaveLength(READ_RECEIPT_BATCH)
  })
})

describe("Mark all read", () => {
  const post = () => markAllRead(new NextRequest("http://x/api/mobile/conversations/read", { method: "POST" }))

  beforeEach(() => {
    mockDb.private_messages.updateMany.mockResolvedValue({ count: 3 })
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
    // Delivered first, while the unread predicate still finds them; both predicates, no id lists.
    expect(writes()).toEqual([
      { where: expect.objectContaining({ is_read: false, delivered_at: null }), data: { delivered_at: expect.any(Date) } },
      { where: expect.objectContaining({ is_read: false, sender_id: { not: "reader" } }), data: { is_read: true } },
    ])
    // One look at the reader's setting for every conversation.
    expect(mockDb.profiles.findUnique).toHaveBeenCalledTimes(1)
  })

  it("says nothing of the reads when the reader has receipts off", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ read_receipts: false })
    await post()
    await settle()
    expect(reads()).toEqual([])
  })

  it("a million unread is a bounded number of reads, writes and emits", async () => {
    mockDb.private_messages.findMany.mockReset()
    // Every page full, three conversations: as if the backlog never ends.
    mockDb.private_messages.findMany.mockImplementation(async ({ take }) =>
      Array.from({ length: take }, (_, i) => ({ id: `x${i}`, conversation_id: `c${i % 3}`, delivered_at: null }))
    )
    await post()
    await settle()
    expect(mockDb.private_messages.findMany).toHaveBeenCalledTimes(10)
    expect(mockDb.private_messages.updateMany).toHaveBeenCalledTimes(2)
    expect(mockDb.profiles.findUnique).toHaveBeenCalledTimes(1)
    expect(reads()).toHaveLength(3)
    expect(delivered()).toHaveLength(3)
    for (const e of emitted) expect((e.payload as { messageIds: string[] }).messageIds.length).toBeLessThanOrEqual(READ_RECEIPT_BATCH)
  })
})

describe("the socket's own read", () => {
  const socketEmits: Array<{ event: string; payload: unknown }> = []
  const socket = {
    data: { userId: "reader" },
    to: () => ({ emit: (event: string, payload: unknown) => socketEmits.push({ event, payload }) }),
  } as unknown as AuthenticatedSocket

  beforeEach(() => {
    socketEmits.length = 0
    mockDb.private_messages.findMany.mockReset()
    mockDb.private_messages.findMany.mockResolvedValue([{ id: "m1" }]) // not yet delivered
  })

  it("counts as delivered, and announces the read once (no second private:read, no private:delivered)", async () => {
    await emitPrivateRead(socket, "c1", ["m1"])
    expect(deliveredWrite()).toEqual({ where: { id: { in: ["m1"] }, delivered_at: null }, data: { delivered_at: expect.any(Date) } })
    await settle()
    expect(socketEmits.map((e) => e.event)).toEqual(["private:read"])
    expect(emitted).toEqual([])
  })

  it("with receipts off, still says delivered — delivery is not private", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ read_receipts: false })
    await emitPrivateRead(socket, "c1", ["m1"])
    expect(socketEmits).toEqual([{ event: "private:delivered", payload: { conversationId: "c1", messageIds: ["m1"] } }])
  })
})
