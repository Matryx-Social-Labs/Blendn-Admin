import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { overUserLimit } from "@/lib/rate-limit"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/* Follow-ups to the API abuse sweep (security review of fix/security-abuse). */
/* eslint-disable @typescript-eslint/no-require-imports */
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
const requests = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
const leave = require("@/app/api/mobile/conversations/[conversationId]/leave/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/leave/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  await db.message_requests.deleteMany({ where: { sender_id: { in: users } } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" })

it("event chat: a swept-to-left muted member who reopens the chat stays muted", async () => {
  const host = await makeUser(testId("fu_host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const me = await person("fu_muted")
  await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId: me.id })
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })
  await db.chat_group_members.create({
    data: { chat_group_id: group.id, user_id: me.id, status: "left", anonymous_name: testId("Otter"), muted_at: new Date(), muted_by: host },
  })

  const res = await eventChat.GET(new NextRequest(`http://localhost/api/mobile/events/${eventId}/chat`, { headers: auth(me.token) }), {
    params: Promise.resolve({ eventId }),
  })
  expect(res.status).toBe(200)
  const row = await db.chat_group_members.findUniqueOrThrow({
    where: { chat_group_id_user_id: { chat_group_id: group.id, user_id: me.id } },
    select: { status: true },
  })
  expect(row.status).toBe("muted")
})

it("message requests: a sender's daily allowance runs out with a 429", async () => {
  const a = await person("fu_req_a")
  const b = await person("fu_req_b")
  for (let i = 0; i < 25; i++) await overUserLimit("requestDay", "message-request-day", a.id)
  const res = await requests.POST(
    new NextRequest("http://localhost/api/mobile/message-requests", {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({ recipientId: b.id, message: "coffee?" }),
    })
  )
  expect(res.status).toBe(429)
})

it("conversation leave: over the report cap, the leave still happens and only the report is dropped", async () => {
  const a = await person("fu_lv_a")
  const b = await person("fu_lv_b")
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  const conv = await db.private_conversations.create({ data: { user1_id, user2_id } })
  for (let i = 0; i < 31; i++) await overUserLimit("reportDay", "report-conversation-day", a.id)

  const res = await leave.POST(
    new NextRequest(`http://localhost/api/mobile/conversations/${conv.id}/leave`, {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({ action: "block", report: { reason: "harassment" } }),
    }),
    { params: Promise.resolve({ conversationId: conv.id }) }
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ data: { reported: false, reportAccepted: false } })
  expect((await db.private_conversations.findUniqueOrThrow({ where: { id: conv.id } })).closed_at).not.toBeNull()
  expect(await db.blocked_users.count({ where: { blocker_id: a.id, blocked_id: b.id } })).toBe(1)
  expect(await db.user_reports.count({ where: { reporter_id: a.id } })).toBe(0)
})
