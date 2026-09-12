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

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
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
