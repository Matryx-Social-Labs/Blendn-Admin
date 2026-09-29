import { NextRequest } from "next/server"
import jwt from "jsonwebtoken"
import { randomUUID } from "crypto"

/*
 * A per-person limit counts the person, whichever token they hold (SCRUM-439).
 *
 * The room-message and checkout limiters were keyed on the last 16 characters
 * of the Authorization header. That is the tail of the JWT's signature, so
 * every access token was its own bucket: a refresh every 15 minutes, or a
 * second phone, and the person had a fresh allowance. Found by the SCRUM-417
 * load test.
 *
 * Each request below carries a token of its own for the same person, as a
 * refresh or a second device would. The counted attempts are refused after the
 * limiter (a missing room, an empty body), so nothing is written.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { db, closeDb, makeUser, onboard } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventChatRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as
  typeof import("@/app/api/mobile/events/[eventId]/chat/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkoutRoute = require("@/app/api/mobile/events/[eventId]/checkout/route") as
  typeof import("@/app/api/mobile/events/[eventId]/checkout/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dmRoute = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as
  typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")

const users: string[] = []
const conversations: string[] = []

afterAll(async () => {
  if (conversations.length) {
    await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
    await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function person() {
  return (await personWithId()).token
}

async function personWithId() {
  const id = await makeUser("limit")
  users.push(id)
  await onboard(id)
  let n = 0
  // A different token every call: the claim `n` changes the signature.
  return { id, token: () => jwt.sign({ userId: id, email: `${id}@itest.invalid`, type: "access", n: n++ }, process.env.MOBILE_JWT_SECRET!, { expiresIn: "15m" }) }
}

const post = (url: string, token: string, body: object) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

const sendToGroup = (token: string, groupId: string, body: object) =>
  groupRoute.POST(post(`http://localhost/api/mobile/chat/groups/${groupId}/messages`, token, body), {
    params: Promise.resolve({ chatGroupId: groupId }),
  })

/** Refused by the limiter, not by anything after it. */
async function expectLimited(res: Response) {
  expect(res.status).toBe(429)
  expect(((await res.json()) as { errorCode?: string }).errorCode).toBe("RATE_LIMITED")
}

describe("the room-message limit (30 a minute) is the person's", () => {
  it("refuses the 31st send on a fresh token", async () => {
    const token = await person()
    const groupId = randomUUID()
    for (let i = 0; i < 30; i++) {
      expect((await sendToGroup(token(), groupId, { content: "hi", type: "text" })).status).toBe(404)
    }
    await expectLimited(await sendToGroup(token(), groupId, { content: "hi", type: "text" }))
    // The allowance is theirs: somebody else in the same room still gets through.
    const other = await person()
    expect((await sendToGroup(other(), groupId, { content: "hi", type: "text" })).status).toBe(404)
  })

  it("counts the event-chat door in the same allowance", async () => {
    const token = await person()
    const eventId = randomUUID()
    for (let i = 0; i < 30; i++) {
      const res = await eventChatRoute.POST(post(`http://localhost/api/mobile/events/${eventId}/chat`, token(), {}), {
        params: Promise.resolve({ eventId }),
      })
      expect(res.status).toBe(400)
    }
    await expectLimited(await sendToGroup(token(), randomUUID(), { content: "hi", type: "text" }))
  })
})

describe("the checkout limit (10 in ten minutes) is the person's", () => {
  it("refuses the 11th checkout on a fresh token", async () => {
    const token = await person()
    const eventId = randomUUID()
    const checkout = (t: string) =>
      checkoutRoute.POST(post(`http://localhost/api/mobile/events/${eventId}/checkout`, t, {}), {
        params: Promise.resolve({ eventId }),
      })
    for (let i = 0; i < 10; i++) expect((await checkout(token())).status).toBe(404)
    await expectLimited(await checkout(token()))
    // Somebody else checking out of the same event is not in that bucket.
    const other = await person()
    expect((await checkout(other())).status).toBe(404)
  })
})

describe("the private-message limit (30 a minute) counts a refused send", () => {
  const conversationOf = async (a: string, b: string) => {
    const c = await db.private_conversations.create({
      data: { user1_id: a, user2_id: b, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
    })
    conversations.push(c.id)
    return c.id
  }
  const sendDm = (token: string, conversationId: string, body: object) =>
    dmRoute.POST(post(`http://localhost/api/mobile/conversations/${conversationId}/messages`, token, body), {
      params: Promise.resolve({ conversationId }),
    })

  /*
   * SCRUM-451: the limiter ran after the lookups that refuse, so sends to a
   * random id, to somebody else's conversation or quoting a message from
   * elsewhere were never counted. A retry of a send that landed (SCRUM-410)
   * still does not spend it.
   */
  it("refuses the 31st after 30 refused sends, and still answers a retry", async () => {
    const me = await personWithId()
    const friend = await personWithId()
    const strangers = [await personWithId(), await personWithId()]
    const mine = await conversationOf(me.id, friend.id)
    const theirs = await conversationOf(strangers[0].id, strangers[1].id)
    const clientId = randomUUID()
    const landed = await db.private_messages.create({
      data: { conversation_id: mine, sender_id: me.id, message_text: "hi", client_id: clientId },
    })

    for (let i = 0; i < 10; i++) {
      expect((await sendDm(me.token(), randomUUID(), { text: "hi" })).status).toBe(404)
      expect((await sendDm(me.token(), theirs, { text: "hi" })).status).toBe(403)
      expect((await sendDm(me.token(), mine, { text: "hi", replyToId: randomUUID() })).status).toBe(400)
    }
    await expectLimited(await sendDm(me.token(), mine, { text: "hi" }))

    const retry = await sendDm(me.token(), mine, { text: "hi", clientId })
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { data: { id: string } }).data.id).toBe(landed.id)
    // A known clientId aimed at another conversation is not a retry: counted.
    await expectLimited(await sendDm(me.token(), theirs, { text: "hi", clientId }))
    expect(await db.private_messages.count({ where: { sender_id: me.id } })).toBe(1)
  })
})
