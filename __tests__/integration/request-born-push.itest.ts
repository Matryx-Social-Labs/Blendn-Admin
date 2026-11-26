import { NextRequest } from "next/server"

/*
 * Launch gate 7, widened (SCRUM-1266): no push for a conversation that began as
 * a request shows a real name or a message preview. Real routes, real rows:
 * A asks B, B accepts, A writes, and every push and bell row is read for a name
 * or the words. Controls: a match's DM keeps its pseudonym and words, a friends'
 * DM its name (advisor pick A: the gate is about requests).
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-request-born-secret-of-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

type Sent = { to: string; title?: string; body?: string; data?: Record<string, string> }
const mockSent: Sent[] = []
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Sent[]) {
      mockSent.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  },
}))

import { conversationPair } from "@/lib/conversations"
import { signAccessToken } from "@/lib/mobile-auth"
import { roomHandle } from "@/lib/room-handle"
import { cleanup, closeDb, db, establish, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const requests = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const respond = require("@/app/api/mobile/message-requests/[requestId]/respond/route") as typeof import("@/app/api/mobile/message-requests/[requestId]/respond/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const messages = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")

interface Person {
  id: string
  name: string
  token: string
}
const users: string[] = []
const events: string[] = []
const conversations: string[] = []

afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  const convs = await db.private_conversations.findMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] }, select: { id: true } })
  const ids = [...conversations, ...convs.map((c) => c.id)]
  await db.private_messages.deleteMany({ where: { conversation_id: { in: ids } } })
  await db.private_conversations.deleteMany({ where: { id: { in: ids } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

beforeEach(() => {
  mockSent.length = 0
})

async function person(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await establish(id)
  const name = `Priya ${label}`
  await db.user.update({ where: { id }, data: { name } })
  await db.profiles.update({ where: { id }, data: { name } })
  await db.push_tokens.create({ data: { user_id: id, token: `ExponentPushToken[${id}]`, platform: "ios" } })
  return { id, name, token: signAccessToken(id, `${id}@itest.invalid`) }
}

const post = (url: string, token: string, body: unknown) =>
  new NextRequest(`http://localhost/api/mobile${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

/** Pushes and their bell rows are fire and forget. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 500))
const pushesTo = (p: Person) => mockSent.filter((m) => m.to === `ExponentPushToken[${p.id}]`)

async function dm(from: Person, conversationId: string, text: string) {
  const res = await messages.POST(post(`/conversations/${conversationId}/messages`, from.token, { text }), {
    params: Promise.resolve({ conversationId }),
  })
  expect([200, 201]).toContain(res.status)
  await settle()
}

async function conversationOf(a: Person, b: Person, over: Record<string, unknown>) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  const c = await db.private_conversations.create({ data: { user1_id, user2_id, ...over }, select: { id: true } })
  conversations.push(c.id)
  return c.id
}

describe("a conversation that began as a request: no name, no words, on any push", () => {
  it("the request, the accept and the first DM each say only what happened", async () => {
    const host = await makeUser(testId("rbp-host"), "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const occurrenceId = await occurrenceOf(eventId)
    const [a, b] = await Promise.all([person("rbp-a"), person("rbp-b")])
    for (const p of [a, b]) await putInRoom({ eventId, occurrenceId, userId: p.id })

    // A asks B.
    const asked = await requests.POST(post("/message-requests", a.token, { recipientId: roomHandle(eventId, b.id), message: "coffee after this?" }))
    expect(asked.status).toBe(201)
    await settle()
    const request = await db.message_requests.findFirstOrThrow({ where: { sender_id: a.id, recipient_id: b.id } })
    expect(pushesTo(b).map((m) => [m.title, m.body])).toEqual([["New message request", "Someone wants to connect"]])

    // B accepts.
    const accepted = await respond.POST(post(`/message-requests/${request.id}/respond`, b.token, { action: "accept" }), {
      params: Promise.resolve({ requestId: request.id }),
    })
    expect(accepted.status).toBe(200)
    await settle()
    expect(pushesTo(a).map((m) => [m.title, m.body])).toEqual([["Message request accepted", "Your message request was accepted"]])

    // A writes; the conversation is request-born.
    const conversation = await db.private_conversations.findFirstOrThrow({ where: { OR: [{ user1_id: a.id, user2_id: b.id }, { user1_id: b.id, user2_id: a.id }] } })
    expect(conversation).toMatchObject({ user1_pseudonym: null, user2_pseudonym: null, origin_friendship: false })
    await dm(a, conversation.id, "meet me by the back door at 9")
    expect(pushesTo(b).at(-1)).toMatchObject({ title: "New message", body: "Open Blend’n to read it", data: expect.objectContaining({ type: "private_message", conversationId: conversation.id }) })

    // Nothing either of them was sent, and nothing in their bells, names anybody or quotes anything.
    const bell = await db.notifications.findMany({ where: { user_id: { in: [a.id, b.id] } }, select: { kind: true, title: true, body: true } })
    expect(bell.map((r) => r.kind).sort()).toEqual(["message_request", "message_request_response"])
    for (const text of [JSON.stringify(mockSent), JSON.stringify(bell)]) {
      for (const leak of [a.name, b.name, "Priya", "back door", "coffee"]) expect(text).not.toContain(leak)
    }
  })
})

describe("controls: other conversations keep today's push", () => {
  it("a match's DM keeps its pseudonym and its words", async () => {
    const [a, b] = await Promise.all([person("rbp-ma"), person("rbp-mb")])
    const id = await conversationOf(a, b, {
      user1_pseudonym: "Quiet Otter",
      user2_pseudonym: "Amber Fox",
    })
    const mine = conversationPair(a.id, b.id)[0] === a.id ? "Quiet Otter" : "Amber Fox"
    await dm(a, id, "the corner table")
    expect(pushesTo(b).at(-1)).toMatchObject({ title: mine, body: "the corner table" })
  })

  it("a friends' DM keeps the name and the words", async () => {
    const [a, b] = await Promise.all([person("rbp-fa"), person("rbp-fb")])
    const [user1_id, user2_id] = conversationPair(a.id, b.id)
    await db.friendships.create({ data: { user1_id, user2_id } })
    const id = await conversationOf(a, b, { origin_friendship: true })
    await dm(a, id, "see you there")
    expect(pushesTo(b).at(-1)).toMatchObject({ title: a.name, body: "see you there" })
  })
})
