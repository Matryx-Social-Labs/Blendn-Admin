import { NextRequest } from "next/server"

/*
 * The two safety writes a phone makes with optional fields left out.
 *
 * `description` on a message report and `note` on a peer rating are optional
 * in their schemas, and the app omits both by default — so each arrived as an
 * explicit `undefined`, `strictUndefinedChecks` refused the write, and
 * reporting a message or rating a peer without a note returned 500. Found by
 * driving the report from the API as an attendee; the rating by reading the
 * client, which sends `note.trim() || undefined`. No regex sees a bare
 * variable; this does: post the route, read the row.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const reportRoute = require("@/app/api/mobile/messages/[messageId]/report/route") as
  typeof import("@/app/api/mobile/messages/[messageId]/report/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ratingRoute = require("@/app/api/mobile/events/[eventId]/peer-ratings/route") as
  typeof import("@/app/api/mobile/events/[eventId]/peer-ratings/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const leaveRoute = require("@/app/api/mobile/conversations/[conversationId]/leave/route") as
  typeof import("@/app/api/mobile/conversations/[conversationId]/leave/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const userReportRoute = require("@/app/api/mobile/users/[userId]/report/route") as
  typeof import("@/app/api/mobile/users/[userId]/report/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventReportRoute = require("@/app/api/mobile/events/[eventId]/report/route") as
  typeof import("@/app/api/mobile/events/[eventId]/report/route")

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.event_reports.deleteMany({ where: { user_id: { in: users } } })
  await db.blocked_users.deleteMany({ where: { blocker_id: { in: users } } })
  await db.peer_ratings.deleteMany({ where: { rater_id: { in: users } } })
  await db.event_likes.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(label)
  users.push(id)
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, user.email) }
}

const post = (url: string, token: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

it("reports a room message with no description and writes the row", async () => {
  const host = await makeUser("sw-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const reporter = await person("sw-reporter")
  const author = await person("sw-author")
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "sw room" } })
  await db.chat_group_members.createMany({
    data: [
      { chat_group_id: group.id, user_id: reporter.id, anonymous_name: "Quiet Otter" },
      { chat_group_id: group.id, user_id: author.id, anonymous_name: "Amber Fox" },
    ],
  })
  const message = await db.chat_messages.create({
    data: { chat_group_id: group.id, user_id: author.id, content: "buy followers dm me", type: "text" },
  })

  const res = await reportRoute.POST(
    post(`/api/mobile/messages/${message.id}/report`, reporter.token, { messageType: "group", reason: "spam" }),
    { params: Promise.resolve({ messageId: message.id }) }
  )
  expect(res.status).toBe(201)
  const row = await db.message_reports.findFirst({ where: { message_id: message.id, reporter_id: reporter.id } })
  expect(row).toMatchObject({ message_type: "group", reason: "spam", description: null, status: "pending" })
})

it("rates a connected peer with no note and writes the row", async () => {
  const host = await makeUser("sw-host2", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const now = Date.now()
  // Ratings open after the event; `ratablePeers` also wants a mutual like.
  await db.events.update({
    where: { id: eventId },
    data: { start_time: new Date(now - 4 * 3600_000), end_time: new Date(now - 3600_000) },
  })
  const me = await person("sw-rater")
  const them = await person("sw-rated")
  await db.event_likes.createMany({
    data: [
      { event_id: eventId, liker_id: me.id, liked_id: them.id },
      { event_id: eventId, liker_id: them.id, liked_id: me.id },
    ],
  })

  const res = await ratingRoute.POST(
    post(`/api/mobile/events/${eventId}/peer-ratings`, me.token, { userId: them.id, rating: 4 }),
    { params: Promise.resolve({ eventId }) }
  )
  expect([200, 201]).toContain(res.status)
  const row = await db.peer_ratings.findFirst({ where: { event_id: eventId, rater_id: me.id } })
  expect(row).toMatchObject({ rated_id: them.id, rating: 4, issue: "none", note: null })
})

it("refuses a rating across a block, as for someone never connected with (SCRUM-304)", async () => {
  const host = await makeUser("sw-host-blk", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const now = Date.now()
  await db.events.update({
    where: { id: eventId },
    data: { start_time: new Date(now - 4 * 3600_000), end_time: new Date(now - 3600_000) },
  })
  const blocker = await person("sw-blocker")
  const blocked = await person("sw-blocked")
  await db.event_likes.createMany({
    data: [
      { event_id: eventId, liker_id: blocker.id, liked_id: blocked.id },
      { event_id: eventId, liker_id: blocked.id, liked_id: blocker.id },
    ],
  })
  await db.blocked_users.create({ data: { blocker_id: blocker.id, blocked_id: blocked.id } })

  const res = await ratingRoute.POST(
    post(`/api/mobile/events/${eventId}/peer-ratings`, blocked.token, { userId: blocker.id, rating: 1, issue: "harassment" }),
    { params: Promise.resolve({ eventId }) }
  )
  expect(res.status).toBe(403)
  expect(await db.peer_ratings.count({ where: { event_id: eventId } })).toBe(0)
  expect(await db.user_reports.count({ where: { reporter_id: blocked.id } })).toBe(0)
})

it("blocks and reports from a conversation with no description, in one transaction", async () => {
  /*
   * "Block and report" on the phone sends `{ action: "block", report: { reason:
   * "other" } }` — no description — and the whole transaction rolled back:
   * no block, no report, thread still open, and the sheet said "Could not do
   * that". Driven on iOS, tenth of its kind.
   */
  const me = await person("sw-leaver")
  const them = await person("sw-left")
  const conversation = await db.private_conversations.create({
    data: { user1_id: me.id, user2_id: them.id, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
  })

  const res = await leaveRoute.POST(
    post(`/api/mobile/conversations/${conversation.id}/leave`, me.token, {
      action: "block",
      report: { reason: "other" },
    }),
    { params: Promise.resolve({ conversationId: conversation.id }) }
  )
  expect(res.status).toBe(200)
  const closed = await db.private_conversations.findUniqueOrThrow({ where: { id: conversation.id } })
  expect(closed.closed_reason).toBe("block")
  expect(await db.blocked_users.count({ where: { blocker_id: me.id, blocked_id: them.id } })).toBe(1)
  const report = await db.user_reports.findFirst({ where: { reporter_id: me.id, reported_id: them.id } })
  expect(report).toMatchObject({ reason: "other", description: null })
  await db.private_conversations.delete({ where: { id: conversation.id } })
})

it("reports a person and an event with no description", async () => {
  // The same optional in two more routes, found by sweeping after the one above.
  const me = await person("sw-rep")
  const them = await person("sw-reported")
  const host = await makeUser("sw-host3", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)

  const u = await userReportRoute.POST(
    post(`/api/mobile/users/${them.id}/report`, me.token, { reason: "spam" }),
    { params: Promise.resolve({ userId: them.id }) }
  )
  expect([200, 201]).toContain(u.status)
  expect(await db.user_reports.findFirst({ where: { reporter_id: me.id, reported_id: them.id } })).toMatchObject({
    reason: "spam",
    description: null,
  })

  const e = await eventReportRoute.POST(
    post(`/api/mobile/events/${eventId}/report`, me.token, { reason: "misleading" }),
    { params: Promise.resolve({ eventId }) }
  )
  expect([200, 201]).toContain(e.status)
  expect(await db.event_reports.findFirst({ where: { user_id: me.id, event_id: eventId } })).toMatchObject({
    reason: "misleading",
    description: null,
  })
})
