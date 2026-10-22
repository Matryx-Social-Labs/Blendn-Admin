import { NextRequest } from "next/server"

/*
 * A send refused as a burst says when to try again (SV13): `retryAfter` seconds
 * in the body and in `Retry-After`, beside `errorCode` SPAM_BLOCKED, which does
 * not change. A message refused for its links has no `retryAfter`.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { screenDirectMessage } from "@/lib/dm-moderation"
import { clearAllSpamHistory } from "@/lib/moderation/spam-detector"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const groupMessages = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
let eventId = ""
let groupId = ""
let token = ""
let userId = ""

beforeAll(async () => {
  const host = await makeUser(testId("sbr-host"), "organizer")
  userId = await makeUser(testId("sbr-guest"))
  users.push(host, userId)
  eventId = await makeEvent(host)
  events.push(eventId)
  groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })).id
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: userId, status: "active", anonymous_name: testId("Heron") } })
  await db.event_check_ins.create({
    data: {
      event_id: eventId,
      occurrence_id: (await db.event_occurrences.findFirstOrThrow({ where: { event_id: eventId } })).id,
      user_id: userId,
      status: "checked_in",
      check_in_time: new Date(),
      last_seen_at: new Date(),
    },
  })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  token = signAccessToken(userId, email)
})

afterAll(async () => {
  await clearAllSpamHistory()
  await db.chat_messages.deleteMany({ where: { chat_group_id: groupId } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

beforeEach(() => clearAllSpamHistory())

const send = (content: string) =>
  groupMessages.POST(
    new NextRequest(`http://localhost/api/mobile/chat/groups/${groupId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    }),
    { params: Promise.resolve({ chatGroupId: groupId }) }
  )

it("a burst refusal carries retryAfter in the body and the header, and errorCode stays SPAM_BLOCKED", async () => {
  for (let i = 0; i < 5; i++) expect((await send(`hello number ${i} about something different`)).status).toBeLessThan(300)
  const res = await send("and one more entirely other thing")
  expect(res.status).toBe(429)
  const body = await res.json()
  expect(body).toMatchObject({ success: false, errorCode: "SPAM_BLOCKED" })
  expect(body.retryAfter).toBeGreaterThanOrEqual(1)
  expect(body.retryAfter).toBeLessThanOrEqual(10)
  expect(res.headers.get("Retry-After")).toBe(String(body.retryAfter))
})

it("the event chat door says the same", async () => {
  const sendEvent = (content: string) =>
    eventChat.POST(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      }),
      { params: Promise.resolve({ eventId }) }
    )
  for (let i = 0; i < 5; i++) await sendEvent(`event hello ${i} that is not alike`)
  const res = await sendEvent("one too many of them now")
  expect(res.status).toBe(429)
  expect(await res.json()).toMatchObject({ errorCode: "SPAM_BLOCKED", retryAfter: expect.any(Number) })
})

it("a message refused for its links has no retryAfter: waiting would not help", async () => {
  const res = await send("http://a.example http://b.example http://c.example http://d.example")
  expect(res.status).toBe(429)
  const body = await res.json()
  expect(body.errorCode).toBe("SPAM_BLOCKED")
  expect(body).not.toHaveProperty("retryAfter")
  expect(res.headers.get("Retry-After")).toBeNull()
})

it("a direct message screened as a burst carries it too", async () => {
  let last: Awaited<ReturnType<typeof screenDirectMessage>> | null = null
  for (let i = 0; i < 6; i++) last = await screenDirectMessage({ senderId: userId, conversationId: "conv-1", text: `dm ${i} of a very different sort` })
  expect(last).toMatchObject({ verdict: "refuse", code: "spam", retryAfter: expect.any(Number) })
})
