import { NextRequest } from "next/server"

/*
 * A DM thread opens at its first unread, carries replies and delivery, and a
 * retried send writes once (SCRUM-406, SCRUM-408, SCRUM-409, SCRUM-410).
 * Through the real routes against Postgres; the Expo transport is stubbed.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: unknown[]) {
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  },
}))

import { randomUUID } from "crypto"
import { signAccessToken } from "@/lib/mobile-auth"
import { emitPrivateDelivered } from "@/lib/socket-server"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dmRoute = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as
  typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const inboxRoute = require("@/app/api/mobile/conversations/route") as
  typeof import("@/app/api/mobile/conversations/route")

const users: string[] = []
const conversations: string[] = []
const events: string[] = []

afterAll(async () => {
  if (conversations.length) {
    await db.private_messages.updateMany({ where: { conversation_id: { in: conversations } }, data: { reply_to_id: null } })
    await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
    await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  }
  if (events.length) {
    const groups = await db.chat_groups.findMany({ where: { event_id: { in: events } }, select: { id: true } })
    const ids = groups.map((g) => g.id)
    await db.chat_messages.deleteMany({ where: { chat_group_id: { in: ids } } })
    await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: ids } } })
    await db.chat_groups.deleteMany({ where: { id: { in: ids } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, auth: signAccessToken(id, email) }
}

const req = (url: string, auth: string, body?: object) =>
  new NextRequest(url, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

async function pair() {
  const a = await person("dt_a")
  const b = await person("dt_b")
  const c = await db.private_conversations.create({
    data: { user1_id: a.id, user2_id: b.id, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
  })
  conversations.push(c.id)
  const url = `http://localhost/api/mobile/conversations/${c.id}/messages`
  const params = { params: Promise.resolve({ conversationId: c.id }) }
  const send = async (who: { auth: string }, body: object) => {
    const res = await dmRoute.POST(req(url, who.auth, body), params)
    return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown>; error?: string } }
  }
  const open = async (who: { auth: string }, query = "") => {
    const res = await dmRoute.GET(req(`${url}${query}`, who.auth), params)
    return (await res.json()) as {
      data: {
        messages: { id: string; text: string; deliveredAt?: string | null; replyTo?: Record<string, unknown> | null }[]
        firstUnreadId?: string | null
        unreadCount?: number
      }
    }
  }
  return { a, b, conversationId: c.id, send, open }
}

describe("opening a thread", () => {
  it("names the first unread, then marks the whole thread read and delivered — past the first page too", async () => {
    const { a, b, conversationId, open } = await pair()
    const base = Date.now() - 60 * 60 * 1000
    // 60 unread from A, older than one page of 50.
    await db.private_messages.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        conversation_id: conversationId,
        sender_id: a.id,
        message_text: `m${i}`,
        created_at: new Date(base + i * 1000),
      })),
    })
    const first = await db.private_messages.findFirstOrThrow({
      where: { conversation_id: conversationId },
      orderBy: { created_at: "asc" },
    })

    const page = await open(b)
    expect(page.data.firstUnreadId).toBe(first.id)
    expect(page.data.unreadCount).toBe(60)

    const left = await db.private_messages.count({
      where: { conversation_id: conversationId, OR: [{ is_read: false }, { delivered_at: null }] },
    })
    expect(left).toBe(0)
  })

  it("shows the sender when their message was delivered", async () => {
    const { a, b, send, open } = await pair()
    const sent = await send(a, { text: "hello" })
    const before = await open(a)
    expect(before.data.messages.find((m) => m.id === sent.json.data!.id)?.deliveredAt).toBeNull()
    await open(b)
    const after = await open(a)
    expect(after.data.messages.find((m) => m.id === sent.json.data!.id)?.deliveredAt).toBeTruthy()
  })
})

describe("loading the inbox", () => {
  it("marks everything sent to you delivered, without reading it", async () => {
    const { a, b, send } = await pair()
    const sent = await send(a, { text: "while you were out" })
    await inboxRoute.GET(req("http://localhost/api/mobile/conversations", b.auth))
    // Delivery is recorded after the list answers; give it a moment.
    await new Promise((r) => setTimeout(r, 300))
    const row = await db.private_messages.findUniqueOrThrow({ where: { id: sent.json.data!.id as string } })
    expect(row.delivered_at).not.toBeNull()
    expect(row.is_read).toBe(false)
  })
})

describe("replying", () => {
  it("stores the reply and quotes it by the name the reader knows", async () => {
    const { a, b, send, open } = await pair()
    const asked = await send(a, { text: "corner table?" })
    const reply = await send(b, { text: "yes!", replyToId: asked.json.data!.id })
    expect(reply.status).toBeLessThan(300)
    expect(reply.json.data!.replyTo).toMatchObject({ id: asked.json.data!.id, text: "corner table?" })

    const thread = await open(a)
    const row = thread.data.messages.find((m) => m.id === reply.json.data!.id)!
    // Not revealed: the quoted author is A's pseudonym, never a real name.
    expect(row.replyTo).toMatchObject({ id: asked.json.data!.id, senderName: "Quiet Otter", text: "corner table?" })
  })

  it("refuses a reply to a message from another conversation", async () => {
    const one = await pair()
    const two = await pair()
    const elsewhere = await one.send(one.a, { text: "not yours" })
    const res = await two.send(two.a, { text: "hm", replyToId: elsewhere.json.data!.id })
    expect(res.status).toBe(400)
  })
})

describe("a retried send", () => {
  it("writes once and answers with the same message", async () => {
    const { a, conversationId, send } = await pair()
    const clientId = randomUUID()
    const first = await send(a, { text: "only once", clientId })
    const again = await send(a, { text: "only once", clientId })
    expect(again.json.data!.id).toBe(first.json.data!.id)
    expect(await db.private_messages.count({ where: { conversation_id: conversationId } })).toBe(1)
  })

  it("in a room too", async () => {
    const owner = await makeUser(testId("dt_own"), "organizer")
    users.push(owner)
    const event = await db.events.create({
      data: {
        slug: testId("dt"),
        title: "room",
        description: "fixture",
        start_time: new Date(Date.now() - 3600_000),
        end_time: new Date(Date.now() + 3600_000),
        timezone: "UTC",
        status: "published",
        organizer_id: owner,
      },
    })
    events.push(event.id)
    const group = await db.chat_groups.create({ data: { event_id: event.id, name: "room", status: "active" } })
    const p = await person("dt_m")
    await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: p.id, anonymous_name: `P ${testId("x")}` } })
    const clientId = randomUUID()
    const post = () =>
      groupRoute.POST(
        req(`http://localhost/api/mobile/chat/groups/${group.id}/messages`, p.auth, { content: "once", type: "text", clientId }),
        { params: Promise.resolve({ chatGroupId: group.id }) }
      )
    const r1 = (await (await post()).json()) as { data: { id: string } }
    const r2 = (await (await post()).json()) as { data: { id: string } }
    expect(r2.data.id).toBe(r1.data.id)
    expect(await db.chat_messages.count({ where: { chat_group_id: group.id } })).toBe(1)
  })
})

describe("the delivered ack", () => {
  it("marks the recipient's messages delivered and tells the room", async () => {
    const { a, b, conversationId, send } = await pair()
    const sent = await send(a, { text: "ping" })
    const emitted: unknown[] = []
    const socket = {
      data: { userId: b.id },
      to: () => ({ emit: (...args: unknown[]) => emitted.push(args) }),
    }
    await emitPrivateDelivered(socket as never, conversationId, [sent.json.data!.id as string])
    const row = await db.private_messages.findUniqueOrThrow({ where: { id: sent.json.data!.id as string } })
    expect(row.delivered_at).not.toBeNull()
    expect(emitted).toEqual([["private:delivered", { conversationId, messageIds: [sent.json.data!.id] }]])
  })

  it("does nothing for the sender acking their own message", async () => {
    const { a, conversationId, send } = await pair()
    const sent = await send(a, { text: "mine" })
    const socket = { data: { userId: a.id }, to: () => ({ emit: jest.fn() }) }
    await emitPrivateDelivered(socket as never, conversationId, [sent.json.data!.id as string])
    const row = await db.private_messages.findUniqueOrThrow({ where: { id: sent.json.data!.id as string } })
    expect(row.delivered_at).toBeNull()
  })
})
