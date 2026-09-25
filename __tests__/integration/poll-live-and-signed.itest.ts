import { NextRequest } from "next/server"

/*
 * An organiser's poll reaches the room live and signed (SCRUM-307).
 *
 * Driven on staging: two announcements reached an open socket within a
 * second, and the poll posted between them produced no event at all —
 * `createPoll` wrote the row and never emitted. In the history both staff
 * posts read as from "Attendee", because staff are not room members;
 * an announcement at least carries the organisation in its text, a poll's
 * text is only the question. Real rows; the socket is the one thing mocked.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const mockEmit = jest.fn()
jest.mock("@/lib/socket-server", () => ({
  ...jest.requireActual("@/lib/socket-server"),
  emitChatMessage: (...a: unknown[]) => mockEmit(...a),
}))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const { createPoll } = require("@/lib/poll-actions") as typeof import("@/lib/poll-actions")
const groupHistory = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
const dashboardFeed = require("@/app/api/events/[id]/chat/messages/route") as typeof import("@/app/api/events/[id]/chat/messages/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const ORG = testId("Nightshift QA")
const PSEUDONYM = testId("Heron")
let eventId = ""
let groupId = ""
let host = ""
let guestToken = ""

afterAll(async () => {
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

beforeAll(async () => {
  host = await makeUser(testId("pls-host"), "organizer")
  const guest = await makeUser(testId("pls-guest"))
  users.push(host, guest)
  const org = await db.organisations.create({ data: { kind: "company", display_name: ORG, status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner" } })
  eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })
  groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })).id
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: guest, status: "active", anonymous_name: PSEUDONYM } })
  // The host is in the room too, under a pseudonym — the room's own voice must still read as the organisation.
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: host, status: "active", anonymous_name: testId("Kestrel") } })
  await db.chat_messages.create({ data: { chat_group_id: groupId, user_id: guest, content: "who else is here?" } })
  await db.chat_messages.create({ data: { chat_group_id: groupId, user_id: host, type: "announcement", content: `📢 [Announcement from ${ORG}]\ndoors at 7` } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: guest }, select: { email: true } })
  guestToken = signAccessToken(guest, email)
  mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })
})

const get = (url: string) => new NextRequest(`http://localhost${url}`, { headers: { authorization: `Bearer ${guestToken}` } })

type Row = { content: string | null; user: { name: string } }
const namesBy = (rows: Row[]) => Object.fromEntries(rows.map((m) => [m.content ?? "", m.user.name]))

it("emits a new poll to the room at once, signed by the organisation", async () => {
  const { messageId } = await createPoll(eventId, { question: "Best brew method?", options: ["Pour-over", "Aeropress"] })
  expect(mockEmit).toHaveBeenCalledWith(
    groupId,
    expect.objectContaining({ id: messageId, type: "poll", content: "Best brew method?", userName: ORG })
  )
})

it("names staff posts after the organisation in both histories, and attendees by their pseudonym", async () => {
  const viaGroup = (await (await groupHistory.GET(get(`/api/mobile/chat/groups/${groupId}/messages`), { params: Promise.resolve({ chatGroupId: groupId }) })).json()) as { data: { messages: Row[] } }
  const viaEvent = (await (await eventChat.GET(get(`/api/mobile/events/${eventId}/chat`), { params: Promise.resolve({ eventId }) })).json()) as { data: { messages: Row[] } }
  for (const rows of [viaGroup.data.messages, viaEvent.data.messages]) {
    const names = namesBy(rows)
    expect(names["Best brew method?"]).toBe(ORG)
    expect(names[`📢 [Announcement from ${ORG}]\ndoors at 7`]).toBe(ORG)
    expect(names["who else is here?"]).toBe(PSEUDONYM)
  }
})

it("badges the poll as a poll in the organiser's own feed", async () => {
  const res = await dashboardFeed.GET(new Request(`http://localhost/api/events/${eventId}/chat/messages`), { params: Promise.resolve({ id: eventId }) })
  const body = (await res.json()) as { messages: { content: string; kind: string }[] }
  const kinds = Object.fromEntries(body.messages.map((m) => [m.content, m.kind]))
  expect(kinds["Best brew method?"]).toBe("poll")
  expect(kinds["who else is here?"]).toBe("user")
})

it("returns the committed poll even when the emit throws — a retry would post it twice", async () => {
  mockEmit.mockImplementationOnce(() => {
    throw new Error("adapter down")
  })
  const { pollId } = await createPoll(eventId, { question: "Second round?", options: ["Yes", "No"] })
  expect(await db.chat_polls.count({ where: { id: pollId } })).toBe(1)
})
