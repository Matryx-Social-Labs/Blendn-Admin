import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { overUserLimit } from "@/lib/rate-limit"
import { cleanup, closeDb, db, makeUser } from "./helpers"

/*
 * API M8 (security audit): four report endpoints (and the leave route's
 * report) had no daily cap and took free text of any size. Each now shares the
 * `reportDay` bucket the crew/board reports already use, and bounds its text.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const messageReport = require("@/app/api/mobile/messages/[messageId]/report/route") as typeof import("@/app/api/mobile/messages/[messageId]/report/route")
const userReport = require("@/app/api/mobile/users/[userId]/report/route") as typeof import("@/app/api/mobile/users/[userId]/report/route")
const eventReport = require("@/app/api/mobile/events/[eventId]/report/route") as typeof import("@/app/api/mobile/events/[eventId]/report/route")
const roomReport = require("@/app/api/mobile/chat/groups/[chatGroupId]/report/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/report/route")
const convLeave = require("@/app/api/mobile/conversations/[conversationId]/leave/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/leave/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const ID = "11111111-1111-4111-8111-111111111111"
const users: string[] = []
afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
async function person(label: string) {
  const id = await makeUser(label)
  users.push(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}
const post = (h: Handler, as: { token: string }, params: Record<string, string>, body: unknown) =>
  h(
    new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) as Promise<never> }
  )

const huge = "x".repeat(5000)
const routes: Array<[string, Handler, Record<string, string>, string, unknown]> = [
  ["message", messageReport.POST as Handler, { messageId: ID }, "report-message-day", { messageType: "group", reason: "spam" }],
  ["user", userReport.POST as Handler, { userId: ID }, "report-user-day", { reason: "spam" }],
  ["event", eventReport.POST as Handler, { eventId: ID }, "report-event-day", { reason: "spam" }],
  ["room", roomReport.POST as Handler, { chatGroupId: ID }, "report-room-day", { reason: "spam" }],
  ["conversation leave", convLeave.POST as Handler, { conversationId: ID }, "report-conversation-day", { report: { reason: "spam" } }],
]

describe.each(routes)("%s report", (_name, handler, params, scope, body) => {
  it("refuses with 429 once the user's daily report allowance is spent", async () => {
    const me = await person("rc_cap")
    for (let i = 0; i < 31; i++) await overUserLimit("reportDay", scope, me.id)
    expect((await post(handler, me, params, body)).status).toBe(429)
  })

  it("refuses free text beyond the cap with 400", async () => {
    const me = await person("rc_len")
    const long = (b: unknown) => {
      const o = JSON.parse(JSON.stringify(b)) as Record<string, unknown>
      const target = (o.report as Record<string, unknown> | undefined) ?? o
      return { ...o, ...(o.report ? { report: { ...target, description: huge } } : { description: huge }) }
    }
    expect((await post(handler, me, params, long(body))).status).toBe(400)
    const longReason = (b: unknown) => {
      const o = JSON.parse(JSON.stringify(b)) as Record<string, unknown>
      return o.report ? { ...o, report: { ...(o.report as object), reason: huge } } : { ...o, reason: huge }
    }
    expect((await post(handler, me, params, longReason(body))).status).toBe(400)
  })
})

it("db is reachable (fixture sanity)", async () => {
  expect(await db.user.count({ where: { id: { in: users } } })).toBeGreaterThan(0)
})
