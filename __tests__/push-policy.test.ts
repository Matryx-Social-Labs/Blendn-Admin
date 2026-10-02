import { readFileSync } from "fs"
import { join } from "path"
import type { ExpoPushMessage } from "expo-server-sdk"

/**
 * What earns a push, and how it lands on the phone.
 *
 * There were three floods, each a push per message to everybody who could
 * receive it:
 *
 *   a DM          one alert per message, however fast they came
 *   a room        every message to every member — two hundred people, three
 *                 hundred messages, sixty thousand pushes — including members
 *                 who had gone home, because membership is attendance
 *   a check-in    "X just checked in!" to everyone already there, so the first
 *                 person through the door heard about the next hundred
 *
 * And every one of them wrote a row to the bell, so the bell was a second,
 * worse copy of the inbox. These pin what replaced them.
 */

const tokens = jest.fn()
const created = jest.fn()
const createdMany = jest.fn()
const parentOf = jest.fn()
const membershipOf = jest.fn()
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
    chat_group_members: { findUnique: (...a: unknown[]) => membershipOf(...a) },
  },
}))

jest.mock("@/lib/conversations", () => ({
  blockCounterparties: (...a: unknown[]) => blocks(...a),
}))

jest.mock("@/lib/socket-server", () => ({ emitChatMessage: jest.fn() }))

jest.mock("@/lib/room-handle", () => ({
  roomHandle: (_eventId: string, userId: string) => `handle-of-${userId}`,
}))

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

import {
  DM_PUSH_WINDOW_MS,
  deliveryFor,
  notifyPrivateMessage,
  notifyRoomReply,
  sendBulkPushNotifications,
  sendPushNotification,
} from "@/lib/push-notifications"
import { deliverToRoom } from "@/lib/room-delivery"
import { resetMemoryStore } from "@/lib/rate-limit-store"

const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")

/** An event's room: `last_allowed_at` is read only in a venue day's (`liveInVenueDay`). */
// The room's door reads its kind and owner too (step 7): an event room, published.
const eventRoom = {
  last_allowed_at: null,
  chat_group: { kind: "event", event: { kind: "event", status: "published", deleted_at: null }, board_post: null },
}

beforeEach(() => {
  mockSent.length = 0
  resetMemoryStore()
  jest.useRealTimers()
  for (const m of [tokens, created, createdMany, parentOf, membershipOf, blocks]) m.mockReset()
  tokens.mockResolvedValue([{ token: "ExponentPushToken[device]" }])
  created.mockResolvedValue({})
  blocks.mockResolvedValue([])
  parentOf.mockResolvedValue({ user_id: "author" })
  membershipOf.mockResolvedValue({ status: "active", ...eventRoom })
})

describe("where each kind lands", () => {
  /*
   * The app created one Android channel, `default`, at the highest importance,
   * and the server sent DMs, friend requests and matches on `messages` — which
   * did not exist, so Android filed them under "Miscellaneous" at normal
   * importance while room chatter rode `default` as a heads-up. The things
   * that are about you were quieter than the things that were not.
   */
  it("a DM is one notification per conversation, replaced in place", () => {
    expect(deliveryFor({ type: "private_message", conversationId: "c1" })).toEqual({
      channelId: "messages",
      threadId: "dm:c1",
      collapseId: "dm:c1",
      tag: "dm:c1",
    })
  })

  it("a room reply is one notification per room", () => {
    expect(deliveryFor({ type: "group_message", chatGroupId: "g1" })).toEqual({
      channelId: "rooms",
      threadId: "room:g1",
      collapseId: "room:g1",
      tag: "room:g1",
    })
  })

  it("an event change replaces the last one: only the latest state of an event is true", () => {
    expect(deliveryFor({ type: "event_update", eventId: "e1" })).toEqual({
      channelId: "events",
      threadId: "event:e1",
      collapseId: "event:e1",
      tag: "event:e1",
    })
  })

  it("an announcement stacks with its event but never replaces an earlier one", () => {
    // "Doors moved to the side entrance" must survive "Raffle at nine".
    expect(deliveryFor({ type: "announcement", eventId: "e1", chatGroupId: "g1" })).toEqual({
      channelId: "events",
      threadId: "event:e1",
    })
  })

  it("people-shaped moments go on the messages channel and are never collapsed", () => {
    for (const type of ["friend_request", "friend_accepted", "match", "message_request"] as const) {
      expect(deliveryFor({ type })).toEqual({ channelId: "messages" })
    }
  })

  it("never names a channel the app does not create", () => {
    // Every kind in the enum, so a kind added later is checked too. The app
    // creates these three (blendn `lib/notifications.ts`); `default` only
    // carries a payload with no type.
    const block = /enum notification_kind \{([^}]*)\}/.exec(read("prisma", "schema.prisma"))![1]
    const kinds = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-z_]+$/.test(l))
    expect(kinds.length).toBeGreaterThan(10)
    for (const type of kinds) {
      const { channelId } = deliveryFor({ type: type as never, eventId: "e", conversationId: "c", chatGroupId: "g" })
      expect(["messages", "rooms", "events"]).toContain(channelId)
    }
    expect(deliveryFor(undefined).channelId).toBe("default")
  })
})

describe("a burst of DMs is one alert", () => {
  const dm = (unread: number, preview = "hey") =>
    notifyPrivateMessage({
      recipientId: "r",
      senderName: "Quiet Otter",
      preview,
      conversationId: "c1",
      unread,
    })

  it("the first unread message rings, with its words", async () => {
    await dm(1, "are you at the bar?")
    expect(mockSent).toHaveLength(1)
    expect(mockSent[0]).toMatchObject({
      title: "Quiet Otter",
      body: "are you at the bar?",
      collapseId: "dm:c1",
      channelId: "messages",
    })
  })

  it("the rest of the burst sends nothing", async () => {
    await dm(1)
    await dm(2)
    await dm(3)
    expect(mockSent).toHaveLength(1)
  })

  it("a burst still unread after the window rings once more, counted", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-28T20:00:00Z") })
    await dm(1)
    await dm(2)
    jest.setSystemTime(Date.now() + DM_PUSH_WINDOW_MS + 1)
    await dm(4)
    expect(mockSent).toHaveLength(2)
    expect(mockSent[1].body).toBe("4 new messages")
  })

  it("reading the conversation resets it: the next message rings at once", async () => {
    await dm(1)
    await dm(2)
    // They opened it; this message is the only unread one again.
    await dm(1)
    expect(mockSent).toHaveLength(2)
  })

  it("one conversation's burst does not silence another's", async () => {
    await dm(1)
    await notifyPrivateMessage({ recipientId: "r", senderName: "Cosmic Panda", preview: "hi", conversationId: "c2", unread: 1 })
    expect(mockSent).toHaveLength(2)
  })
})

describe("messages live in their inbox, not the bell", () => {
  /*
   * The Banter list and the Room badge already count unread messages. A bell
   * row per message was the same fact a second time, and it buried the things
   * only the bell carries — a friend request, a cancelled event.
   */
  it("a DM push writes no bell row", async () => {
    await notifyPrivateMessage({ recipientId: "r", senderName: "x", preview: "y", conversationId: "c1", unread: 1 })
    expect(created).not.toHaveBeenCalled()
  })

  it("a room reply writes no bell row", async () => {
    await notifyRoomReply({
      recipientId: "r",
      senderName: "x",
      groupName: "g",
      preview: "y",
      chatGroupId: "g1",
      senderHandle: "h",
    })
    expect(created).not.toHaveBeenCalled()
  })

  it("a friend request still does", async () => {
    await sendPushNotification({ userId: "r", title: "t", body: "b", data: { type: "friend_request", requestId: "q" } })
    expect(created).toHaveBeenCalledTimes(1)
  })

  it("the feed and both unread counts hide rows written before this change", () => {
    // Those rows age out under the retention sweeper; until then they must
    // not be what somebody sees when they open the bell.
    const feed = read("app", "api", "mobile", "notifications", "route.ts")
    const markRead = read("app", "api", "mobile", "notifications", "read", "route.ts")
    expect(feed.match(/kind: \{ notIn: NOT_IN_THE_BELL \}/g)).toHaveLength(2)
    expect(markRead.match(/kind: \{ notIn: NOT_IN_THE_BELL \}/g)).toHaveLength(1)
  })
})

describe("a bell row reaches an open app at once", () => {
  /*
   * The push shows on the lock screen; with the app open, the bell's badge only
   * moved when the Pulse next came into focus. `notification:new` goes to the
   * person's own socket room with the kind and nothing else — the app reads the
   * row through `GET /notifications` like any other.
   */
  const emitted: { rooms: string | string[]; event: string; payload: unknown }[] = []
  const shared = globalThis as { __blendnSocketIo?: unknown }

  beforeEach(() => {
    emitted.length = 0
    shared.__blendnSocketIo = {
      to: (rooms: string | string[]) => ({
        emit: (event: string, payload: unknown) => emitted.push({ rooms, event, payload }),
      }),
    }
  })
  afterAll(() => {
    shared.__blendnSocketIo = undefined
  })

  it("tells the recipient's app when a friend request lands", async () => {
    await sendPushNotification({ userId: "r", title: "t", body: "b", data: { type: "friend_request", requestId: "q" } })
    expect(emitted).toEqual([{ rooms: ["user:r"], event: "notification:new", payload: { kind: "friend_request" } }])
  })

  it("tells everyone an announcement reached, in one broadcast", async () => {
    createdMany.mockResolvedValue({ count: 2 })
    await sendBulkPushNotifications({
      userIds: ["a", "b"],
      title: "t",
      body: "b",
      data: { type: "announcement", eventId: "e1", chatGroupId: "g1" },
    })
    expect(emitted).toEqual([{ rooms: ["user:a", "user:b"], event: "notification:new", payload: { kind: "announcement" } }])
  })

  it("says nothing for a message, which writes no row", async () => {
    await notifyPrivateMessage({ recipientId: "r", senderName: "x", preview: "y", conversationId: "c1", unread: 1 })
    expect(emitted).toHaveLength(0)
  })

  it("says nothing when the row was not written", async () => {
    created.mockRejectedValue(new Error("busy"))
    await sendPushNotification({ userId: "r", title: "t", body: "b", data: { type: "friend_request", requestId: "q" } })
    expect(emitted).toHaveLength(0)
  })
})

describe("a room pushes replies, and only to the person replied to", () => {
  const send = (parentId: string | null, senderId = "sender") =>
    deliverToRoom({
      chatGroupId: "g1",
      scope: "e1",
      groupName: "Friday at Toit",
      senderId,
      senderAnonName: "Cosmic Panda",
      message: {
        id: `m-${Math.random()}`,
        content: "same, see you there",
        type: "text",
        user_id: senderId,
        created_at: new Date(),
        parent_id: parentId,
      },
      preview: "same, see you there",
    })

  it("an ordinary message pushes nobody", async () => {
    await send(null)
    expect(mockSent).toHaveLength(0)
    expect(parentOf).not.toHaveBeenCalled()
  })

  it("a reply reaches its author, by handle, on the rooms channel", async () => {
    await send("p1")
    expect(mockSent).toHaveLength(1)
    expect(tokens.mock.calls[0][0].where.user_id).toBe("author")
    expect(mockSent[0]).toMatchObject({
      title: "Friday at Toit",
      body: "Cosmic Panda replied: same, see you there",
      channelId: "rooms",
      collapseId: "room:g1",
    })
    // SCRUM-371: a room never sends another person's real id.
    expect(mockSent[0].data).toMatchObject({ type: "group_message", chatGroupId: "g1", senderId: "handle-of-sender" })
  })

  it("replying to yourself pushes nobody", async () => {
    parentOf.mockResolvedValue({ user_id: "sender" })
    await send("p1")
    expect(mockSent).toHaveLength(0)
  })

  it("never reaches someone in a block with the sender", async () => {
    blocks.mockResolvedValue(["author"])
    await send("p1")
    expect(mockSent).toHaveLength(0)
  })

  it.each(["left", "banned"])("never reaches an author who has %s", async (status) => {
    membershipOf.mockResolvedValue({ status, ...eventRoom })
    await send("p1")
    expect(mockSent).toHaveLength(0)
  })

  it("never reaches an author whose Go Live at the venue has ended, and does while it is open", async () => {
    // A venue day's room is the people live in it (`liveInVenueDay`, F6).
    const venueDay = (until: number) => ({ status: "active", last_allowed_at: new Date(until), chat_group: { kind: "event", event: { kind: "venue_day", status: "published", deleted_at: null }, board_post: null } })
    membershipOf.mockResolvedValue(venueDay(Date.now() - 60_000))
    await send("p1")
    expect(mockSent).toHaveLength(0)
    membershipOf.mockResolvedValue(venueDay(Date.now() + 60_000))
    await send("p2")
    expect(mockSent).toHaveLength(1)
  })

  it("still reaches a muted author: muted cannot post, and still reads", async () => {
    membershipOf.mockResolvedValue({ status: "muted", ...eventRoom })
    await send("p1")
    expect(mockSent).toHaveLength(1)
  })

  it("a thread of replies to one person rings once", async () => {
    await send("p1")
    await send("p2", "someone-else")
    await send("p3", "a-third")
    expect(mockSent).toHaveLength(1)
  })
})

describe("a check-in pushes nobody", () => {
  it("has no push sender and no call site", () => {
    expect(read("lib", "push-notifications.ts")).not.toContain("notifyEventCheckIn")
    expect(read("app", "api", "mobile", "events", "[eventId]", "checkin", "route.ts")).not.toContain(
      "push-notifications"
    )
  })
})
