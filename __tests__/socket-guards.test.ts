process.env.NEXTAUTH_SECRET = "socket-guards-test-secret-of-32-characters"
const mockDb = {
  chat_group_members: { findUnique: jest.fn() },
  private_conversations: { findUnique: jest.fn() },
  // Typing leaves out the typist's block counterparties (SCRUM-338).
  blocked_users: { findMany: jest.fn().mockResolvedValue([]) },
  profiles: { findUnique: jest.fn() },
  // `emitPrivateRead` persists before it relays: the receipt used to be a live
  // broadcast that reverted to a single tick on reload.
  private_messages: { updateMany: jest.fn() },
  // The emitter asks a room's kind: a venue day's goes only to the people live in it.
  events: { findUnique: jest.fn().mockResolvedValue({ kind: "event" }) },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("socket.io", () => ({ Server: class {} }))
jest.mock("@/lib/mobile-auth", () => ({ verifyAccessToken: jest.fn() }))

import { startSponsoredScheduler, stopSponsoredScheduler } from "@/lib/sponsored-scheduler"
import {
  guardJoin,
  emitChatTyping,
  emitPrivateTyping,
  emitPrivateRead,
} from "@/lib/socket-server"
import type { AuthenticatedSocket } from "@/lib/socket-server"
import { roomHandle } from "@/lib/room-handle"

const USER = "user_self"
const CHAT_ID = "11111111-1111-1111-1111-111111111111"
const EVENT_ID = "22222222-2222-4222-8222-222222222222"
const member = (anonymous_name: string | null, status: string, venueDayWindow?: Date | null) => ({
  anonymous_name,
  status,
  last_allowed_at: venueDayWindow ?? null,
  chat_group: {
    id: CHAT_ID,
    kind: "event",
    event_id: EVENT_ID,
    event: { status: "published", deleted_at: null, kind: venueDayWindow === undefined ? "event" : "venue_day" },
    board_post: null,
  },
})
// Deliberately shares no substring with USER, so the leak assertion below
// can only fail on a genuine email leak.
const EMAIL_LOCAL_PART = "zaphod.beeblebrox"

function makeSocket() {
  const roomEmit = jest.fn()
  const except = jest.fn()
  const broadcast = { emit: roomEmit, except }
  except.mockReturnValue(broadcast)
  /*
   * The chat room as `fetchSockets` returns it: somebody else, the typist's
   * other device, and the typing socket itself. Typing is per recipient now
   * (SCRUM-371), so `roomEmit` is what the other person's socket receives.
   */
  const ownOtherDeviceEmit = jest.fn()
  const typingSocketEmit = jest.fn()
  const chatRoom = {
    except,
    fetchSockets: jest.fn(async () => [
      { id: "sock-peer", data: { userId: "user_peer" }, emit: roomEmit },
      { id: "sock-self-2", data: { userId: USER }, emit: ownOtherDeviceEmit },
      { id: "sock-self", data: { userId: USER }, emit: typingSocketEmit },
    ]),
  }
  except.mockImplementation(() => ({ ...broadcast, ...chatRoom }))
  const socket = {
    id: "sock-self",
    data: { userId: USER, email: `${EMAIL_LOCAL_PART}@example.com` },
    join: jest.fn(),
    emit: jest.fn(),
    to: jest.fn(() => broadcast),
    nsp: { in: jest.fn(() => chatRoom) },
  }
  return {
    socket: socket as unknown as AuthenticatedSocket,
    raw: socket,
    roomEmit,
    except,
    ownOtherDeviceEmit,
    typingSocketEmit,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("guardJoin", () => {
  it("joins the room when the check authorizes", async () => {
    const { socket, raw } = makeSocket()
    await guardJoin(socket, "chat:abc", "denied", async () => true)

    expect(raw.join).toHaveBeenCalledWith("chat:abc")
    expect(raw.emit).not.toHaveBeenCalled()
  })

  it("does not join and tells the client when the check denies", async () => {
    const { socket, raw } = makeSocket()
    await guardJoin(socket, "chat:abc", "Not authorized to join this chat", async () => false)

    expect(raw.join).not.toHaveBeenCalled()
    expect(raw.emit).toHaveBeenCalledWith("error", {
      message: "Not authorized to join this chat",
      code: "FORBIDDEN",
    })
  })

  it("denies instead of crashing when the check throws", async () => {
    // This is the fail-closed path. Socket.io does not await its listeners, so
    // before this guard a rejection here escaped as an unhandledRejection and
    // terminated the process — any authenticated client could trigger it with
    // a malformed room ID.
    const { socket, raw } = makeSocket()

    await expect(
      guardJoin(socket, "chat:bad", "Not authorized to join this chat", async () => {
        throw new Error("Inconsistent column data: Error creating UUID")
      })
    ).resolves.toBeUndefined()

    expect(raw.join).not.toHaveBeenCalled()
    expect(raw.emit).toHaveBeenCalledWith("error", {
      message: "Not authorized to join this chat",
      code: "FORBIDDEN",
    })
  })

  it("does not leak whether the room exists — same denial either way", async () => {
    const missing = makeSocket()
    await guardJoin(missing.socket, "chat:a", "Not authorized to join this chat", async () => false)

    const throwing = makeSocket()
    await guardJoin(throwing.socket, "chat:b", "Not authorized to join this chat", async () => {
      throw new Error("boom")
    })

    expect(missing.raw.emit.mock.calls).toEqual(throwing.raw.emit.mock.calls)
  })
})

describe("emitChatTyping", () => {
  it("broadcasts under the anonymous name for an active member", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue(member("Cosmic Panda", "active"))
    const { socket, raw, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, true)

    expect(raw.nsp.in).toHaveBeenCalledWith(`chat:${CHAT_ID}`)
    // Everybody else reads the typist as this event's handle (SCRUM-371).
    expect(roomEmit).toHaveBeenCalledWith("chat:typing", {
      chatGroupId: CHAT_ID,
      userId: roomHandle(EVENT_ID, USER),
      userName: "Cosmic Panda",
      isTyping: true,
    })
  })

  it("names the typist by their real id to their own other device, and not back to the typing socket", async () => {
    // The app drops its own typing by comparing ids, so its own copy stays real.
    mockDb.chat_group_members.findUnique.mockResolvedValue(member("Cosmic Panda", "active"))
    const { socket, ownOtherDeviceEmit, typingSocketEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, true)

    expect(ownOtherDeviceEmit).toHaveBeenCalledWith("chat:typing", expect.objectContaining({ userId: USER }))
    expect(typingSocketEmit).not.toHaveBeenCalled()
  })

  it("leaves out everyone the typist blocked or was blocked by (SCRUM-338)", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue(member("Hidden Dune", "active"))
    mockDb.blocked_users.findMany.mockResolvedValueOnce([
      { blocker_id: USER, blocked_id: "they_were_blocked" },
      { blocker_id: "they_blocked_me", blocked_id: USER },
    ])
    const { socket, except, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, true)

    expect(except).toHaveBeenCalledWith(["user:they_were_blocked", "user:they_blocked_me"])
    expect(roomEmit).toHaveBeenCalledTimes(1)
  })

  it("drops the indicator rather than throwing when the block lookup fails", async () => {
    // Inside the same try as the membership read: a failed lookup must neither
    // escape the listener (it would take the process down) nor fall back to
    // broadcasting to everyone, blocked people included.
    mockDb.chat_group_members.findUnique.mockResolvedValue(member("Hidden Dune", "active"))
    mockDb.blocked_users.findMany.mockRejectedValueOnce(new Error("connection terminated"))
    const { socket, roomEmit } = makeSocket()

    await expect(emitChatTyping(socket, CHAT_ID, true)).resolves.toBeUndefined()
    expect(roomEmit).not.toHaveBeenCalled()
  })

  it("types into a venue's room only while the typist's Go Live is open (F6)", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue(member("Neon Phoenix", "active", new Date(Date.now() - 60_000)))
    const ended = makeSocket()
    await emitChatTyping(ended.socket, CHAT_ID, true)
    expect(ended.roomEmit).not.toHaveBeenCalled()

    mockDb.chat_group_members.findUnique.mockResolvedValue(member("Neon Phoenix", "active", new Date(Date.now() + 60_000)))
    const live = makeSocket()
    await emitChatTyping(live.socket, CHAT_ID, true)
    expect(live.roomEmit).toHaveBeenCalledTimes(1)
  })

  it("passes isTyping:false through for stopTyping", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue(member("Neon Phoenix", "active"))
    const { socket, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, false)

    expect(roomEmit).toHaveBeenCalledWith(
      "chat:typing",
      expect.objectContaining({ isTyping: false, userName: "Neon Phoenix" })
    )
  })

  it("never broadcasts the real identity — falls back to 'Someone'", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue(member(null, "active"))
    const { socket, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, true)

    expect(roomEmit).toHaveBeenCalledWith(
      "chat:typing",
      expect.objectContaining({ userName: "Someone" })
    )
    // The email local part must never reach other participants — group chat is
    // pseudonymous by design.
    expect(JSON.stringify(roomEmit.mock.calls)).not.toContain(EMAIL_LOCAL_PART)
  })

  it("stays silent for a non-member", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue(null)
    const { socket, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, true)

    expect(roomEmit).not.toHaveBeenCalled()
  })

  it("stays silent for a muted member", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue(member("Muted Otter", "muted"))
    const { socket, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, true)

    expect(roomEmit).not.toHaveBeenCalled()
  })

  it("stays silent for a member banned after they joined the room", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue(member("Banned Wolf", "banned"))
    const { socket, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, true)

    expect(roomEmit).not.toHaveBeenCalled()
  })

  it("swallows a DB error instead of crashing the process", async () => {
    mockDb.chat_group_members.findUnique.mockRejectedValue(
      new Error("Inconsistent column data: Error creating UUID")
    )
    const { socket, roomEmit } = makeSocket()

    await expect(emitChatTyping(socket, "not-a-uuid", true)).resolves.toBeUndefined()
    expect(roomEmit).not.toHaveBeenCalled()
  })
})

const CONVO_ID = "44444444-4444-4444-4444-444444444444"

describe("emitPrivateTyping / emitPrivateRead", () => {
  // socket.to(room) broadcasts into a room the SENDER need not have joined, so
  // the join guard alone does not protect these. Without a participant check,
  // any authenticated user who guessed a conversation id could spoof typing
  // state and read receipts into someone else's DM.
  const asParticipant = () =>
    mockDb.private_conversations.findUnique.mockResolvedValue({
      user1_id: USER,
      user2_id: "user_other",
    })
  const asOutsider = () =>
    mockDb.private_conversations.findUnique.mockResolvedValue({
      user1_id: "user_other",
      user2_id: "user_third",
    })

  it("broadcasts typing for a participant", async () => {
    asParticipant()
    mockDb.profiles.findUnique.mockResolvedValue({ name: "Trillian" })
    const { socket, roomEmit } = makeSocket()

    await emitPrivateTyping(socket, CONVO_ID, true)

    expect(roomEmit).toHaveBeenCalledWith("private:typing", {
      conversationId: CONVO_ID,
      userId: USER,
      userName: "Trillian",
      isTyping: true,
    })
  })

  it("uses the profile name, never the email local part", async () => {
    asParticipant()
    mockDb.profiles.findUnique.mockResolvedValue({ name: null })
    const { socket, roomEmit } = makeSocket()

    await emitPrivateTyping(socket, CONVO_ID, true)

    expect(roomEmit).toHaveBeenCalledWith(
      "private:typing",
      expect.objectContaining({ userName: "Someone" })
    )
    expect(JSON.stringify(roomEmit.mock.calls)).not.toContain(EMAIL_LOCAL_PART)
  })

  it("drops typing from a non-participant", async () => {
    asOutsider()
    const { socket, roomEmit } = makeSocket()

    await emitPrivateTyping(socket, CONVO_ID, true)

    expect(roomEmit).not.toHaveBeenCalled()
  })

  it("drops typing for a conversation that does not exist", async () => {
    mockDb.private_conversations.findUnique.mockResolvedValue(null)
    const { socket, roomEmit } = makeSocket()

    await emitPrivateTyping(socket, CONVO_ID, true)

    expect(roomEmit).not.toHaveBeenCalled()
  })

  it("records the read, then relays it, for a participant", async () => {
    asParticipant()
    mockDb.profiles.findUnique.mockResolvedValue({ read_receipts: true })
    const { socket, roomEmit } = makeSocket()

    await emitPrivateRead(socket, CONVO_ID, ["m1", "m2"])

    // Persisted, and only for messages the reader did not send — otherwise
    // somebody can mark their own and manufacture a receipt on the other side.
    expect(mockDb.private_messages.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["m1", "m2"] },
          conversation_id: CONVO_ID,
          sender_id: { not: USER },
        }),
        data: { is_read: true },
      })
    )

    expect(roomEmit).toHaveBeenCalledWith("private:read", {
      conversationId: CONVO_ID,
      messageIds: ["m1", "m2"],
      readBy: USER,
    })
  })

  it("records the read but says nothing when the reader has receipts off", async () => {
    /*
     * The setting governs disclosure, never the record. Somebody with read
     * receipts off still clears their own unread badge — suppressing the write
     * would be a privacy toggle silently breaking an unrelated feature.
     */
    asParticipant()
    mockDb.profiles.findUnique.mockResolvedValue({ read_receipts: false })
    const { socket, roomEmit } = makeSocket()

    await emitPrivateRead(socket, CONVO_ID, ["m1"])

    expect(mockDb.private_messages.updateMany).toHaveBeenCalled()
    expect(roomEmit).not.toHaveBeenCalled()
  })

  it("drops forged read receipts from a non-participant", async () => {
    asOutsider()
    const { socket, roomEmit } = makeSocket()

    await emitPrivateRead(socket, CONVO_ID, ["m1"])

    expect(roomEmit).not.toHaveBeenCalled()
  })

  it("swallows DB errors instead of crashing the process", async () => {
    mockDb.private_conversations.findUnique.mockRejectedValue(new Error("boom"))
    const a = makeSocket()
    const b = makeSocket()

    await expect(emitPrivateTyping(a.socket, "not-a-uuid", true)).resolves.toBeUndefined()
    await expect(emitPrivateRead(b.socket, "not-a-uuid", ["m1"])).resolves.toBeUndefined()
    expect(a.roomEmit).not.toHaveBeenCalled()
    expect(b.roomEmit).not.toHaveBeenCalled()
  })
})

describe("stopSponsoredScheduler", () => {
  it("clears the pending pass so shutdown isn't held open by the event loop", () => {
    jest.useFakeTimers()

    startSponsoredScheduler()
    expect(jest.getTimerCount()).toBe(1)

    // Idempotent in both directions: the boot hook can run twice on a hot
    // reload, and the shutdown handler runs on both SIGINT and SIGTERM.
    startSponsoredScheduler()
    expect(jest.getTimerCount()).toBe(1)

    stopSponsoredScheduler()
    expect(jest.getTimerCount()).toBe(0)
    expect(() => stopSponsoredScheduler()).not.toThrow()

    jest.useRealTimers()
  })
})
