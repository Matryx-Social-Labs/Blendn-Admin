import type { ExpoPushMessage } from "expo-server-sdk"

/**
 * A person muting a room for themselves (`POST /chat/groups/:id/mute`).
 *
 * The preference lives in `chat_group_members.notification_preferences` and is
 * read on the two send paths a room has: the reply push and the organiser's
 * announcement. A mute that one of them forgot is a room that still rings, and
 * nothing anywhere would say so.
 */
const tokens = jest.fn()
const created = jest.fn()
const createdMany = jest.fn()
const parentOf = jest.fn()
const membershipOf = jest.fn()
const membersOf = jest.fn()
const blocks = jest.fn()
const mockSent: ExpoPushMessage[] = []

jest.mock("@/lib/db", () => ({
  db: {
    push_tokens: { findMany: (...a: unknown[]) => tokens(...a) },
    notifications: {
      create: (...a: unknown[]) => created(...a),
      createMany: (...a: unknown[]) => createdMany(...a),
    },
    chat_messages: { findUnique: (...a: unknown[]) => parentOf(...a) },
    chat_group_members: {
      findUnique: (...a: unknown[]) => membershipOf(...a),
      findMany: (...a: unknown[]) => membersOf(...a),
    },
  },
}))
jest.mock("@/lib/conversations", () => ({ blockCounterparties: (...a: unknown[]) => blocks(...a) }))
jest.mock("@/lib/socket-server", () => ({ emitChatMessage: jest.fn() }))
jest.mock("@/lib/room-handle", () => ({ roomHandle: (_e: string, u: string) => `handle-of-${u}` }))
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: ExpoPushMessage[]) {
      mockSent.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "ticket" }))
    }
  },
}))

import { deliveryFor, notifyAnnouncement } from "@/lib/push-notifications"
import { deliverToRoom } from "@/lib/room-delivery"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { isRoomMuted, roomMuteState, withMute, withoutMute } from "@/lib/room-mute"

const NOW = new Date("2026-09-28T20:00:00Z")
const HOUR = 60 * 60 * 1000

beforeEach(() => {
  mockSent.length = 0
  resetMemoryStore()
  for (const m of [tokens, created, createdMany, parentOf, membershipOf, membersOf, blocks]) m.mockReset()
  tokens.mockImplementation(async (args: { where: { user_id: string | { in: string[] } } }) => {
    const ids = typeof args.where.user_id === "string" ? [args.where.user_id] : args.where.user_id.in
    return ids.map((user_id) => ({ user_id, token: `ExponentPushToken[${user_id}]` }))
  })
  created.mockResolvedValue({})
  createdMany.mockResolvedValue({ count: 0 })
  blocks.mockResolvedValue([])
  parentOf.mockResolvedValue({ user_id: "author" })
})

describe("the stored preference", () => {
  it("reads nothing, garbage and unmute as not muted", () => {
    for (const prefs of [null, undefined, {}, [], "muted", { muted: "yes" }, { muted: false }]) {
      expect(roomMuteState(prefs as never, NOW)).toEqual({ muted: false, until: null })
    }
  })

  it("reads a mute with no end as muted until turned off", () => {
    expect(roomMuteState({ muted: true, muted_until: null }, NOW)).toEqual({ muted: true, until: null })
  })

  it("lapses on its own: a past until is not muted, with no sweeper needed", () => {
    const until = new Date(NOW.getTime() + HOUR).toISOString()
    expect(roomMuteState({ muted: true, muted_until: until }, NOW)).toEqual({ muted: true, until })
    expect(isRoomMuted({ muted: true, muted_until: until }, new Date(NOW.getTime() + 2 * HOUR))).toBe(false)
  })

  it("treats an unreadable until as lapsed, not for ever", () => {
    expect(isRoomMuted({ muted: true, muted_until: "whenever" }, NOW)).toBe(false)
  })

  it("keeps every other key when muting and unmuting", () => {
    const muted = withMute({ digest: "daily" }, null)
    expect(muted).toEqual({ digest: "daily", muted: true, muted_until: null })
    expect(withoutMute(muted)).toEqual({ digest: "daily" })
  })
})

describe("a muted room does not ring", () => {
  const reply = () =>
    deliverToRoom({
      chatGroupId: "g1",
      scope: "e1",
      groupName: "Friday at Toit",
      senderId: "sender",
      senderAnonName: "Cosmic Panda",
      message: {
        id: `m-${Math.random()}`,
        content: "same",
        type: "text",
        user_id: "sender",
        created_at: new Date(),
        parent_id: "p1",
      },
      preview: "same",
    })

  it("a reply to somebody who muted the room pushes nothing", async () => {
    membershipOf.mockResolvedValue({ status: "active", notification_preferences: { muted: true, muted_until: null } })
    await reply()
    expect(mockSent).toHaveLength(0)
    // The membership read asks for the preference, or the rule has nothing to read.
    expect(membershipOf.mock.calls[0][0].select).toMatchObject({ notification_preferences: true })
  })

  it("a reply reaches them again once the mute has lapsed", async () => {
    membershipOf.mockResolvedValue({
      status: "active",
      notification_preferences: { muted: true, muted_until: new Date(Date.now() - HOUR).toISOString() },
    })
    await reply()
    expect(mockSent).toHaveLength(1)
  })

  it("an announcement skips members who muted the room — push and bell row", async () => {
    membersOf.mockResolvedValue([
      { user_id: "loud", notification_preferences: {} },
      { user_id: "quiet", notification_preferences: { muted: true, muted_until: null } },
    ])
    await notifyAnnouncement("g1", "Friday at Toit", "Doors moved to the side entrance", "e1", "organiser")

    expect(mockSent.map((m) => m.to)).toEqual(["ExponentPushToken[loud]"])
    const rows = createdMany.mock.calls.flatMap(([a]) => a.data)
    expect(rows.map((r: { user_id: string }) => r.user_id)).toEqual(["loud"])
    expect(membersOf.mock.calls[0][0].select).toMatchObject({ notification_preferences: true })
  })
})

describe("the rating request lands with its event", () => {
  it("rides the events channel, one per event, replaced in place", () => {
    expect(deliveryFor({ type: "rating_request", eventId: "e1" })).toEqual({
      channelId: "events",
      threadId: "rate:e1",
      collapseId: "rate:e1",
      tag: "rate:e1",
    })
  })
})
