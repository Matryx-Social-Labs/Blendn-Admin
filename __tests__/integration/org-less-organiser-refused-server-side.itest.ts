/*
 * An organiser in no organisation is refused server-side, not just hidden
 * (SCRUM-251 item 3).
 *
 * Driven on staging: daniel.weber@ (organiser, no organisation) saw none of
 * Nightshift's pages and got 403 on every GET. The charter's last item —
 * replay organizer@'s writes with daniel's session — is covered here in
 * process instead of as a hand-crafted probe against staging: the real
 * handlers, called with daniel's shape, against another organisation's event
 * and its room. Each must refuse and leave the rows as they were.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
import { NextRequest } from "next/server"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const eventRoute = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
const announce = require("@/app/api/events/[id]/announcements/route") as typeof import("@/app/api/events/[id]/announcements/route")
const members = require("@/app/api/events/[id]/chat/members/[userId]/route") as typeof import("@/app/api/events/[id]/chat/members/[userId]/route")
const messages = require("@/app/api/events/[id]/chat/messages/[messageId]/route") as typeof import("@/app/api/events/[id]/chat/messages/[messageId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let eventId = ""
let guestId = ""
let messageId = ""

beforeAll(async () => {
  const host = await makeUser(testId("olo-host"), "organizer")
  const loner = await makeUser(testId("olo-loner"), "organizer")
  guestId = await makeUser(testId("olo-guest"))
  users.push(host, loner, guestId)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("olo-org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner" } })
  eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id, title: "the host's title" } })
  const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })
  await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: guestId, status: "active", anonymous_name: testId("Heron") } })
  messageId = (await db.chat_messages.create({ data: { chat_group_id: room.id, user_id: guestId, content: "hello" }, select: { id: true } })).id
  // daniel's shape: an organiser, signed in, in no organisation.
  mockGetAuth.mockResolvedValue({ user: { id: loner, role: "organizer" } })
})

afterAll(async () => {
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

it("cannot edit or delete another organisation's event", async () => {
  const edit = await eventRoute.PATCH(
    new Request(`http://localhost/api/events/${eventId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "taken over", description: "x", start_time: new Date().toISOString(), end_time: new Date(Date.now() + 3_600_000).toISOString() }),
    }),
    { params: Promise.resolve({ id: eventId }) }
  )
  expect([403, 404]).toContain(edit.status)
  const del = await eventRoute.DELETE(new Request(`http://localhost/api/events/${eventId}`, { method: "DELETE" }), { params: Promise.resolve({ id: eventId }) })
  expect([403, 404]).toContain(del.status)
  const row = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { title: true, deleted_at: true } })
  expect(row).toEqual({ title: "the host's title", deleted_at: null })
})

it("cannot announce to its room, ban its guest, or delete a message there", async () => {
  const posted = await announce.POST(
    new Request(`http://localhost/api/events/${eventId}/announcements`, { method: "POST", body: JSON.stringify({ content: "hijack" }) }),
    { params: Promise.resolve({ id: eventId }) }
  )
  expect([403, 404]).toContain(posted.status)
  const banned = await members.PATCH(
    new NextRequest(`http://localhost/api/events/${eventId}/chat/members/${guestId}`, { method: "PATCH", body: JSON.stringify({ action: "ban" }) }),
    { params: Promise.resolve({ id: eventId, userId: guestId }) }
  )
  expect([403, 404]).toContain(banned.status)
  const removed = await messages.DELETE(new Request(`http://localhost/api/events/${eventId}/chat/messages/${messageId}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: eventId, messageId }),
  })
  expect([403, 404]).toContain(removed.status)

  expect(await db.chat_messages.count({ where: { chat_group: { event_id: eventId }, content: { contains: "hijack" } } })).toBe(0)
  expect((await db.chat_group_members.findFirstOrThrow({ where: { user_id: guestId } })).status).toBe("active")
  expect((await db.chat_messages.findUniqueOrThrow({ where: { id: messageId } })).deleted_at).toBeNull()
})
