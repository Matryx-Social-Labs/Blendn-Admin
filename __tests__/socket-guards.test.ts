const mockDb = {
  chat_group_members: { findUnique: jest.fn() },
  private_conversations: { findUnique: jest.fn() },
  profiles: { findUnique: jest.fn() },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("socket.io", () => ({ Server: class {} }))
jest.mock("@/lib/mobile-auth", () => ({ verifyAccessToken: jest.fn() }))

import {
  guardJoin,
  emitChatTyping,
  emitPrivateTyping,
  emitPrivateRead,
} from "@/lib/socket-server"
import type { AuthenticatedSocket } from "@/lib/socket-server"

const USER = "user_self"
const CHAT_ID = "11111111-1111-1111-1111-111111111111"
// Deliberately shares no substring with USER, so the leak assertion below
// can only fail on a genuine email leak.
const EMAIL_LOCAL_PART = "zaphod.beeblebrox"

function makeSocket() {
  const roomEmit = jest.fn()
  const socket = {
    data: { userId: USER, email: `${EMAIL_LOCAL_PART}@example.com` },
    join: jest.fn(),
    emit: jest.fn(),
    to: jest.fn(() => ({ emit: roomEmit })),
  }
  return { socket: socket as unknown as AuthenticatedSocket, raw: socket, roomEmit }
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
    mockDb.chat_group_members.findUnique.mockResolvedValue({
      anonymous_name: "Cosmic Panda",
      status: "active",
    })
    const { socket, raw, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, true)

    expect(raw.to).toHaveBeenCalledWith(`chat:${CHAT_ID}`)
    expect(roomEmit).toHaveBeenCalledWith("chat:typing", {
      chatGroupId: CHAT_ID,
      userId: USER,
      userName: "Cosmic Panda",
      isTyping: true,
    })
  })

  it("passes isTyping:false through for stopTyping", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue({
      anonymous_name: "Neon Phoenix",
      status: "active",
    })
    const { socket, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, false)

    expect(roomEmit).toHaveBeenCalledWith(
      "chat:typing",
      expect.objectContaining({ isTyping: false, userName: "Neon Phoenix" })
    )
  })

  it("never broadcasts the real identity — falls back to 'Someone'", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue({
      anonymous_name: null,
      status: "active",
    })
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
    mockDb.chat_group_members.findUnique.mockResolvedValue({
      anonymous_name: "Muted Otter",
      status: "muted",
    })
    const { socket, roomEmit } = makeSocket()

    await emitChatTyping(socket, CHAT_ID, true)

    expect(roomEmit).not.toHaveBeenCalled()
  })

  it("stays silent for a member banned after they joined the room", async () => {
    mockDb.chat_group_members.findUnique.mockResolvedValue({
      anonymous_name: "Banned Wolf",
      status: "banned",
    })
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

  it("relays read receipts for a participant", async () => {
    asParticipant()
    const { socket, roomEmit } = makeSocket()

    await emitPrivateRead(socket, CONVO_ID, ["m1", "m2"])

    expect(roomEmit).toHaveBeenCalledWith("private:read", {
      conversationId: CONVO_ID,
      messageIds: ["m1", "m2"],
      readBy: USER,
    })
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
