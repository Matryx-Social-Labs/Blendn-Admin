const mockDb = {
  chat_group_members: { findUnique: jest.fn() },
  private_conversations: { findUnique: jest.fn() },
  events: { findFirst: jest.fn() },
  event_rsvps: { findFirst: jest.fn() },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))

import { canJoinChat, canJoinConversation, canJoinEvent } from "@/lib/socket-auth"

const USER = "user_self"
const OTHER = "user_other"
const CHAT_ID = "11111111-1111-1111-1111-111111111111"
const CONVO_ID = "22222222-2222-2222-2222-222222222222"
const EVENT_ID = "33333333-3333-3333-3333-333333333333"

beforeEach(() => {
  jest.clearAllMocks()
})

describe("canJoinChat", () => {
  it("denies a non-member", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue(null)
    await expect(canJoinChat(USER, CHAT_ID)).resolves.toBe(false)
  })

  it("allows an active member", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue({ status: "active" })
    await expect(canJoinChat(USER, CHAT_ID)).resolves.toBe(true)
  })

  it("allows a muted member (muting blocks writes, not reads)", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue({ status: "muted" })
    await expect(canJoinChat(USER, CHAT_ID)).resolves.toBe(true)
  })

  it("denies a banned member", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue({ status: "banned" })
    await expect(canJoinChat(USER, CHAT_ID)).resolves.toBe(false)
  })

  it("scopes the lookup to the requesting user, not just the group", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue({ status: "active" })
    await canJoinChat(USER, CHAT_ID)
    expect(mockDb.chat_group_members.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chat_group_id_user_id: { chat_group_id: CHAT_ID, user_id: USER },
        },
      })
    )
  })
})

describe("canJoinConversation", () => {
  it("denies a non-existent conversation", async () => {
    mockDb.private_conversations.findUnique.mockResolvedValue(null)
    await expect(canJoinConversation(USER, CONVO_ID)).resolves.toBe(false)
  })

  it("allows user1", async () => {
    mockDb.private_conversations.findUnique.mockResolvedValue({
      user1_id: USER,
      user2_id: OTHER,
    })
    await expect(canJoinConversation(USER, CONVO_ID)).resolves.toBe(true)
  })

  it("allows user2", async () => {
    mockDb.private_conversations.findUnique.mockResolvedValue({
      user1_id: OTHER,
      user2_id: USER,
    })
    await expect(canJoinConversation(USER, CONVO_ID)).resolves.toBe(true)
  })

  it("denies a third party — the DM eavesdropping case", async () => {
    mockDb.private_conversations.findUnique.mockResolvedValue({
      user1_id: OTHER,
      user2_id: "user_third",
    })
    await expect(canJoinConversation(USER, CONVO_ID)).resolves.toBe(false)
  })
})

describe("canJoinEvent", () => {
  it("denies a non-existent event", async () => {
    mockDb.events.findFirst.mockResolvedValue(null)
    await expect(canJoinEvent(USER, EVENT_ID)).resolves.toBe(false)
  })

  it("allows any authenticated user into a public event", async () => {
    // The mobile client subscribes on opening an event detail modal, without
    // checking in — this carve-out keeps the live attendee counter working.
    mockDb.events.findFirst.mockResolvedValue({
      visibility: "public",
      organizer_id: OTHER,
    })
    await expect(canJoinEvent(USER, EVENT_ID)).resolves.toBe(true)
    expect(mockDb.event_rsvps.findFirst).not.toHaveBeenCalled()
  })

  it("allows any authenticated user into an unlisted event", async () => {
    mockDb.events.findFirst.mockResolvedValue({
      visibility: "unlisted",
      organizer_id: OTHER,
    })
    await expect(canJoinEvent(USER, EVENT_ID)).resolves.toBe(true)
  })

  it("denies a stranger from a private event", async () => {
    mockDb.events.findFirst.mockResolvedValue({
      visibility: "private",
      organizer_id: OTHER,
    })
    mockDb.event_rsvps.findFirst.mockResolvedValue(null)
    await expect(canJoinEvent(USER, EVENT_ID)).resolves.toBe(false)
  })

  it("allows the organizer into their own private event", async () => {
    mockDb.events.findFirst.mockResolvedValue({
      visibility: "private",
      organizer_id: USER,
    })
    await expect(canJoinEvent(USER, EVENT_ID)).resolves.toBe(true)
  })

  it("allows an RSVP'd attendee into a private event", async () => {
    mockDb.events.findFirst.mockResolvedValue({
      visibility: "private",
      organizer_id: OTHER,
    })
    mockDb.event_rsvps.findFirst.mockResolvedValue({ id: "rsvp_1" })
    await expect(canJoinEvent(USER, EVENT_ID)).resolves.toBe(true)
  })

  it("only counts a going/maybe RSVP — declining must not grant access", async () => {
    // rsvp_status includes `not_going`. Treating any RSVP row as access would
    // hand a live attendance feed to someone who explicitly declined.
    mockDb.events.findFirst.mockResolvedValue({
      visibility: "private",
      organizer_id: OTHER,
    })
    mockDb.event_rsvps.findFirst.mockResolvedValue(null)

    await expect(canJoinEvent(USER, EVENT_ID)).resolves.toBe(false)
    expect(mockDb.event_rsvps.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["going", "maybe"] } }),
      })
    )
  })

  it("excludes soft-deleted events", async () => {
    mockDb.events.findFirst.mockResolvedValue(null)

    await expect(canJoinEvent(USER, EVENT_ID)).resolves.toBe(false)
    expect(mockDb.events.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deleted_at: null }),
      })
    )
  })
})

describe("malformed room IDs", () => {
  // Room ID columns are `@db.Uuid`, so Prisma throws on a non-UUID string
  // instead of returning null. These must reject so `guardJoin` can deny;
  // an escaping rejection would crash the process (Socket.io does not await
  // its listeners).
  const prismaError = new Error("Inconsistent column data: Error creating UUID")

  it("propagates the error from canJoinChat rather than resolving true", async () => {
    mockDb.chat_group_members.findUnique.mockRejectedValue(prismaError)
    await expect(canJoinChat(USER, "not-a-uuid")).rejects.toThrow()
  })

  it("propagates the error from canJoinConversation", async () => {
    mockDb.private_conversations.findUnique.mockRejectedValue(prismaError)
    await expect(canJoinConversation(USER, "not-a-uuid")).rejects.toThrow()
  })

  it("propagates the error from canJoinEvent", async () => {
    mockDb.events.findFirst.mockRejectedValue(prismaError)
    await expect(canJoinEvent(USER, "not-a-uuid")).rejects.toThrow()
  })
})
