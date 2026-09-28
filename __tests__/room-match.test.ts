process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"
process.env.NEXTAUTH_SECRET = "room-match-test-secret-at-least-32-chars"

/*
 * `room:match` names each person as the OTHER one is entitled to see them.
 *
 * The failure this guards is quiet: the match lands live on both phones, and
 * one of them carries a real name the recipient has not earned — the same
 * one-tap-deep anonymity `lib/conversation-identity.ts` was written to end.
 * Nothing crashes when it regresses; a name simply appears.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  private_conversations: { findUnique: jest.fn() },
  user: { findMany: jest.fn() },
  event_check_ins: { findFirst: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockEmitRoomMatch = jest.fn()
jest.mock("@/lib/socket-server", () => ({ emitRoomMatch: (...a: unknown[]) => mockEmitRoomMatch(...a) }))

const mockAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a) }))
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  userLimit: jest.fn().mockReturnValue({ windowMs: 1, maxRequests: 99 }),
}))
jest.mock("@/lib/conversations", () => ({
  blockedEitherWay: jest.fn().mockResolvedValue(false),
  pairIsClosed: jest.fn().mockResolvedValue(false),
}))
const mockLike = jest.fn()
jest.mock("@/lib/matches", () => ({ likeAtEvent: (...a: unknown[]) => mockLike(...a) }))

import { NextRequest } from "next/server"
import { announceRoomMatch } from "@/lib/room-match"
import { POST as like } from "@/app/api/mobile/events/[eventId]/matches/likes/route"
import { roomHandle } from "@/lib/room-handle"

const EVENT = "22222222-2222-2222-2222-222222222222"
const A = "user-a"
const B = "user-b"

const conversation = (over: Record<string, unknown>) => ({
  user1_id: A,
  user2_id: B,
  user1_pseudonym: "Cosmic Panda",
  user2_pseudonym: "Quiet Otter",
  user1_revealed: false,
  user2_revealed: false,
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.user.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id, name: id === A ? "Arjun Rao" : "Priya Iyer" }))
  )
})

describe("announceRoomMatch", () => {
  it("sends pseudonyms both ways when neither has revealed, and loads no real name", async () => {
    mockDb.private_conversations.findUnique.mockResolvedValue(conversation({}))
    await announceRoomMatch(EVENT, "conv-1")

    expect(mockEmitRoomMatch).toHaveBeenCalledWith({
      eventId: EVENT,
      conversationId: "conv-1",
      a: { userId: A, name: "Cosmic Panda" },
      b: { userId: B, name: "Quiet Otter" },
    })
    expect(mockDb.user.findMany).not.toHaveBeenCalled()
  })

  it("names only the side that revealed", async () => {
    mockDb.private_conversations.findUnique.mockResolvedValue(conversation({ user2_revealed: true }))
    await announceRoomMatch(EVENT, "conv-1")

    const sent = mockEmitRoomMatch.mock.calls[0]![0]
    // A sees B by B's real name (B revealed); B sees A by A's pseudonym.
    expect(sent.b).toEqual({ userId: B, name: "Priya Iyer" })
    expect(sent.a).toEqual({ userId: A, name: "Cosmic Panda" })
    expect(mockDb.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [B] } } })
    )
  })

  it("never rejects, so it cannot fail the like", async () => {
    mockDb.private_conversations.findUnique.mockRejectedValue(new Error("db down"))
    await expect(announceRoomMatch(EVENT, "conv-1")).resolves.toBeUndefined()
    expect(mockEmitRoomMatch).not.toHaveBeenCalled()
  })
})

describe("POST /matches/likes", () => {
  const req = (userId: string = B) =>
    new NextRequest(`https://api.blendn.app/api/mobile/events/${EVENT}/matches/likes`, {
      method: "POST",
      body: JSON.stringify({ userId }),
      headers: { "content-type": "application/json" },
    })

  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: A, email: "a@b.com" })
    mockDb.event_check_ins.findFirst.mockResolvedValue({ id: "ci" })
    mockDb.private_conversations.findUnique.mockResolvedValue(conversation({}))
  })

  it("emits room:match on a mutual like", async () => {
    mockLike.mockResolvedValue({ mutual: true, conversationId: "conv-1", pseudonyms: { you: "Cosmic Panda", them: "Quiet Otter" } })
    const res = await like(req(), { params: Promise.resolve({ eventId: EVENT }) })
    expect(res.status).toBe(200)
    expect(mockEmitRoomMatch).toHaveBeenCalledTimes(1)
  })

  it("takes the deck's handle and likes the person behind it (SCRUM-371)", async () => {
    // The deck sends `roomHandle(event, them)`; the like lands on the real id.
    mockLike.mockResolvedValue({ mutual: false })
    const res = await like(req(roomHandle(EVENT, B)), { params: Promise.resolve({ eventId: EVENT }) })
    expect(res.status).toBe(200)
    expect(mockLike).toHaveBeenCalledWith(EVENT, A, B)
  })

  it("refuses your own handle as it refuses your own id", async () => {
    const res = await like(req(roomHandle(EVENT, A)), { params: Promise.resolve({ eventId: EVENT }) })
    expect(res.status).toBe(400)
    expect(mockLike).not.toHaveBeenCalled()
  })

  it("emits nothing on a one-sided like", async () => {
    mockLike.mockResolvedValue({ mutual: false })
    const res = await like(req(), { params: Promise.resolve({ eventId: EVENT }) })
    expect(res.status).toBe(200)
    expect(mockEmitRoomMatch).not.toHaveBeenCalled()
  })
})
