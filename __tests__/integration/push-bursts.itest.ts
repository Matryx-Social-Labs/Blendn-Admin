import { NextRequest } from "next/server"

/*
 * Bursts, through the real routes against Postgres, with only the Expo
 * transport captured.
 *
 * `push-policy.test.ts` pins the rules with the database mocked. What it cannot
 * see is the one query the DM rule rests on: the recipient's unread count,
 * spread with `VISIBLE_DM` — an `OR` over a nullable column, the exact shape a
 * mock answers however it is told to and Postgres answers by its NULL rules.
 * A hidden message is never marked read; counted, it would turn every later
 * "first" message into "2 new messages" and suppress it inside the window.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockSent: { to: string; body?: string; data?: unknown }[] = []
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: { to: string; body?: string; data?: unknown }[]) {
      mockSent.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "ticket" }))
    }
  },
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dmRoute = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as
  typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventChatRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as
  typeof import("@/app/api/mobile/events/[eventId]/chat/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bellRoute = require("@/app/api/mobile/notifications/route") as
  typeof import("@/app/api/mobile/notifications/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bellReadRoute = require("@/app/api/mobile/notifications/read/route") as
  typeof import("@/app/api/mobile/notifications/read/route")

const users: string[] = []
const conversations: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  if (conversations.length) {
    await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
    await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  }
  if (events.length) {
    const groups = await db.chat_groups.findMany({ where: { event_id: { in: events } }, select: { id: true } })
    const groupIds = groups.map((g) => g.id)
    await db.chat_messages.deleteMany({ where: { chat_group_id: { in: groupIds } } })
    await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: groupIds } } })
    await db.chat_groups.deleteMany({ where: { id: { in: groupIds } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

beforeEach(() => {
  mockSent.length = 0
  resetMemoryStore()
})

/** A person with a device, so a push has somewhere to go. */
async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  const token = `ExponentPushToken[${testId(label)}]`
  await db.push_tokens.create({ data: { user_id: id, token, platform: "ios" } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, device: token, auth: signAccessToken(id, email) }
}

const post = (url: string, auth: string, body: object) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  })

/**
 * The DM push is fire-and-forget after the response. Wait until nothing new
 * has landed for a while, rather than a fixed sleep a slow run could outlast —
 * which would read a late push as a suppressed one.
 */
async function settle(): Promise<void> {
  const quiet = 250
  let seen = -1
  for (let waited = 0; waited < 5000 && seen !== mockSent.length; waited += quiet) {
    seen = mockSent.length
    await new Promise((r) => setTimeout(r, quiet))
  }
}

describe("a DM burst", () => {
  async function pair() {
    const a = await person("pb_a")
    const b = await person("pb_b")
    const c = await db.private_conversations.create({
      data: { user1_id: a.id, user2_id: b.id, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
    })
    conversations.push(c.id)
    const send = async (text: string) => {
      const res = await dmRoute.POST(
        post(`http://localhost/api/mobile/conversations/${c.id}/messages`, a.auth, { text }),
        { params: Promise.resolve({ conversationId: c.id }) }
      )
      expect([200, 201]).toContain(res.status)
      await settle()
    }
    return { a, b, conversationId: c.id, send }
  }

  it("is one push to the recipient, and no bell row", async () => {
    const { b, send } = await pair()
    await send("are you still at the bar")
    await send("the corner table")
    await send("by the window")

    expect(mockSent.filter((m) => m.to === b.device)).toHaveLength(1)
    expect(mockSent[0].body).toBe("are you still at the bar")
    expect(await db.notifications.count({ where: { user_id: b.id } })).toBe(0)
  })

  it("rings again at once after they read it", async () => {
    const { a, b, conversationId, send } = await pair()
    await send("first")
    await send("second")
    await db.private_messages.updateMany({
      where: { conversation_id: conversationId, sender_id: a.id },
      data: { is_read: true },
    })
    await send("after you read")

    const toB = mockSent.filter((m) => m.to === b.device)
    expect(toB.map((m) => m.body)).toEqual(["first", "after you read"])
  })

  it("does not count a hidden message as unread", async () => {
    // Stored and never delivered, so never read: it must not make the next
    // message look like the second of a burst.
    const { a, b, conversationId, send } = await pair()
    await db.private_messages.create({
      data: { conversation_id: conversationId, sender_id: a.id, message_text: "x", moderation_status: "hidden" },
    })
    await send("hello")

    const toB = mockSent.filter((m) => m.to === b.device)
    expect(toB.map((m) => m.body)).toEqual(["hello"])
  })
})

describe("a room", () => {
  async function room() {
    const owner = await makeUser(testId("pb_own"), "organizer")
    users.push(owner)
    const event = await db.events.create({
      data: {
        slug: testId("pb"),
        title: "Friday at Toit",
        description: "integration fixture",
        start_time: new Date(Date.now() - HOUR),
        end_time: new Date(Date.now() + 3 * HOUR),
        timezone: "UTC",
        status: "published",
        organizer_id: owner,
      },
    })
    events.push(event.id)
    const group = await db.chat_groups.create({ data: { event_id: event.id, name: "Friday at Toit", status: "active" } })
    const member = async (label: string) => {
      const p = await person(label)
      await db.chat_group_members.create({
        data: { chat_group_id: group.id, user_id: p.id, anonymous_name: `Pseudo ${testId(label)}` },
      })
      return p
    }
    const say = async (who: { auth: string }, content: string, parentId?: string) => {
      const res = await groupRoute.POST(
        post(`http://localhost/api/mobile/chat/groups/${group.id}/messages`, who.auth, {
          content,
          type: "text",
          ...(parentId ? { parentId } : {}),
        }),
        { params: Promise.resolve({ chatGroupId: group.id }) }
      )
      expect(res.status).toBe(201)
      return ((await res.json()) as { data: { id: string } }).data.id
    }
    /** The event chat screen's write path: the second route into `deliverToRoom`. */
    const sayInEvent = async (who: { auth: string }, content: string, parentId?: string) => {
      const res = await eventChatRoute.POST(
        post(`http://localhost/api/mobile/events/${event.id}/chat`, who.auth, {
          content,
          type: "text",
          ...(parentId ? { parentId } : {}),
        }),
        { params: Promise.resolve({ eventId: event.id }) }
      )
      expect(res.status).toBe(201)
      return ((await res.json()) as { data: { message: { id: string } } }).data.message.id
    }
    return { member, say, sayInEvent }
  }

  it("pushes the author of a reply sent from the event chat screen too", async () => {
    const { member, sayInEvent } = await room()
    const ana = await member("pb_eana")
    const ben = await member("pb_eben")

    const asked = await sayInEvent(ana, "who is by the stage?")
    await settle()
    expect(mockSent).toHaveLength(0)

    await sayInEvent(ben, "right here", asked)
    await settle()
    expect(mockSent.map((m) => m.to)).toEqual([ana.device])
  })

  it("pushes nobody for an ordinary message, and only the author for a reply", async () => {
    const { member, say } = await room()
    const ana = await member("pb_ana")
    const ben = await member("pb_ben")
    const cat = await member("pb_cat")

    const asked = await say(ana, "anyone near the bar?")
    expect(mockSent).toHaveLength(0)

    await say(ben, "yes, by the window", asked)
    expect(mockSent.map((m) => m.to)).toEqual([ana.device])
    expect(mockSent.some((m) => m.to === cat.device)).toBe(false)
    // SCRUM-371: the reply names Ben by his handle in this room, never his id.
    expect(JSON.stringify(mockSent[0].data)).not.toContain(ben.id)
    expect(await db.notifications.count({ where: { user_id: { in: [ana.id, ben.id, cat.id] } } })).toBe(0)
  })
})

describe("the bell", () => {
  /*
   * Rows written before messages left the bell stay until retention takes
   * them. The feed and both unread counts must not show them meanwhile — a
   * badge that counts a DM the Banter already cleared is the flood again.
   */
  it("hides message rows from the feed and from both unread counts", async () => {
    const p = await person("pb_bell")
    await db.notifications.createMany({
      data: [
        { user_id: p.id, kind: "group_message", title: "room", body: "New message in the room" },
        { user_id: p.id, kind: "private_message", title: "dm", body: "Sent you a message" },
        { user_id: p.id, kind: "event_checkin", title: "in", body: "Someone just checked in" },
        { user_id: p.id, kind: "friend_request", title: "New friend request", body: "Someone wants to be friends." },
      ],
    })
    const get = (url: string) =>
      new NextRequest(url, { headers: { authorization: `Bearer ${p.auth}` } })

    const feed = (await (await bellRoute.GET(get("http://localhost/api/mobile/notifications"))).json()) as {
      data: { notifications: { kind: string }[]; unreadCount: number }
    }
    expect(feed.data.notifications.map((n) => n.kind)).toEqual(["friend_request"])
    expect(feed.data.unreadCount).toBe(1)

    // Marking one row read leaves nothing unread that the bell would show.
    const friendRow = await db.notifications.findFirstOrThrow({ where: { user_id: p.id, kind: "friend_request" } })
    const marked = (await (
      await bellReadRoute.POST(post("http://localhost/api/mobile/notifications/read", p.auth, { ids: [friendRow.id] }))
    ).json()) as { data: { unreadCount: number } }
    expect(marked.data.unreadCount).toBe(0)
  })
})
