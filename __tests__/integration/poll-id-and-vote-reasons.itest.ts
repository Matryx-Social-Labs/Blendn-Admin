import { NextRequest } from "next/server"

/*
 * What the poll bubble needs from the server (SV8): the poll's id on a `poll`
 * message (history by group, history by event, and the socket payload), a
 * `reasonCode` beside each 409 sentence on a vote, and which kind of
 * withholding a hidden result is. Real rows; the socket is the one thing mocked.
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
const voteRoute = require("@/app/api/mobile/events/[eventId]/polls/[pollId]/vote/route") as typeof import("@/app/api/mobile/events/[eventId]/polls/[pollId]/vote/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
let eventId = ""
let groupId = ""
let token = ""
let outsiderToken = ""
const orgs: string[] = []

afterAll(async () => {
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

beforeAll(async () => {
  const host = await makeUser(testId("pid-host"), "organizer")
  const guest = await makeUser(testId("pid-guest"))
  const outsider = await makeUser(testId("pid-out"))
  users.push(host, guest, outsider)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("Nightshift QA"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner" } })
  eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })
  groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })).id
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: guest, status: "active", anonymous_name: testId("Heron") } })
  await db.chat_messages.create({ data: { chat_group_id: groupId, user_id: guest, content: "who else is here?" } })
  const emailOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })).email
  token = signAccessToken(guest, await emailOf(guest))
  outsiderToken = signAccessToken(outsider, await emailOf(outsider))
  mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })
})

const authed = (url: string, t = token, init: RequestInit = {}) =>
  new NextRequest(`http://localhost${url}`, { ...init, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" } })

const vote = (pollId: string, optionId: string, t = token) =>
  voteRoute.POST(authed(`/api/mobile/events/${eventId}/polls/${pollId}/vote`, t, { method: "POST", body: JSON.stringify({ optionId }) }), {
    params: Promise.resolve({ eventId, pollId }),
  })

async function newPoll(question: string, extra: { resultsVisible?: boolean } = {}) {
  const made = await createPoll(eventId, { question, options: ["Pour-over", "Aeropress"], ...extra })
  const options = await db.chat_poll_options.findMany({ where: { poll_id: made.pollId }, orderBy: { position: "asc" }, select: { id: true } })
  return { ...made, options: options.map((o) => o.id) }
}

type Msg = { type: string; content: string | null; pollId?: string | null }

it("a poll message carries its poll id in both histories and on the socket; other messages carry none", async () => {
  const { pollId, messageId } = await newPoll("Best brew method?")

  const viaGroup = (await (await groupHistory.GET(authed(`/api/mobile/chat/groups/${groupId}/messages`), { params: Promise.resolve({ chatGroupId: groupId }) })).json()) as { data: { messages: Msg[] } }
  const viaEvent = (await (await eventChat.GET(authed(`/api/mobile/events/${eventId}/chat`), { params: Promise.resolve({ eventId }) })).json()) as { data: { messages: Msg[] } }
  for (const rows of [viaGroup.data.messages, viaEvent.data.messages]) {
    expect(rows.find((m) => m.type === "poll")!.pollId).toBe(pollId)
    expect(rows.find((m) => m.content === "who else is here?")).not.toHaveProperty("pollId")
    expect(rows.find((m) => m.content === "who else is here?")).not.toHaveProperty("poll")
  }
  expect(mockEmit).toHaveBeenCalledWith(groupId, expect.objectContaining({ id: messageId, pollId }), [], eventId)
})

describe("the 409 sentences carry a reasonCode, and errorCode stays CONFLICT", () => {
  it("a closed poll", async () => {
    const p = await newPoll("Closing soon?")
    await db.chat_polls.update({ where: { id: p.pollId }, data: { closes_at: new Date(Date.now() - 1000) } })
    const res = await vote(p.pollId, p.options[0])
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, error: "This poll has closed", errorCode: "CONFLICT", reasonCode: "POLL_CLOSED" })
  })

  it("somebody who is not in the room", async () => {
    const p = await newPoll("Members only?")
    const res = await vote(p.pollId, p.options[0], outsiderToken)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "You are not in this chatroom", errorCode: "CONFLICT", reasonCode: "NOT_IN_ROOM" })
  })

  it("an option from another poll", async () => {
    const a = await newPoll("Poll A?")
    const b = await newPoll("Poll B?")
    const res = await vote(a.pollId, b.options[0])
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "That is not an option on this poll", errorCode: "CONFLICT", reasonCode: "NOT_AN_OPTION" })
  })

  it("a room that has closed", async () => {
    const p = await newPoll("Too late?")
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - 72 * 3600_000), end_time: new Date(Date.now() - 48 * 3600_000) } })
    await db.chat_polls.update({ where: { id: p.pollId }, data: { closes_at: new Date(Date.now() + 3600_000) } })
    const res = await vote(p.pollId, p.options[0])
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ errorCode: "CONFLICT", reasonCode: "ROOM_CLOSED" })
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - 3600_000), end_time: new Date(Date.now() + 3600_000) } })
  })

  it("a good vote answers 200 with no reasonCode", async () => {
    const p = await newPoll("Fine?")
    const res = await vote(p.pollId, p.options[0])
    expect(res.status).toBe(200)
    expect(await res.json()).not.toHaveProperty("reasonCode")
  })
})

describe("which kind of withholding a hidden result is", () => {
  it("an open poll that hides its results says hidden_until_close, with the sentence", async () => {
    const p = await newPoll("Hidden?")
    const res = await vote(p.pollId, p.options[0])
    const body = (await res.json()) as { data: { suppressed: boolean; suppressedReason: string; suppressedLabel: string; options: { votes: number | null }[] } }
    expect(body.data).toMatchObject({ suppressed: true, suppressedReason: "hidden_until_close", suppressedLabel: "Results appear when the poll closes" })
    expect(body.data.options.map((o) => o.votes)).toEqual([null, null])
  })

  it("a closed poll with a handful of votes says few_votes", async () => {
    const p = await newPoll("Few?")
    await vote(p.pollId, p.options[0])
    await db.chat_polls.update({ where: { id: p.pollId }, data: { closes_at: new Date(Date.now() - 1000) } })
    const reread = await (await import("@/lib/polls")).getPollResults(p.pollId, { userId: users[1], eventId })
    expect(reread).toMatchObject({ closed: true, suppressed: true, suppressedReason: "few_votes", total: null })
  })
})
