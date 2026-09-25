import { NextRequest } from "next/server"

/*
 * A deleted event's room takes no writes and leaves the conversation list
 * (SCRUM-303).
 *
 * The dashboard's delete sets `events.deleted_at` and leaves `status` alone.
 * The room rules checked only for a draft, in three places —
 * `roomReadDenial`, `chatWindowState` and, through it, `mayWriteToRoom` — so
 * after a delete a member could still post, react, rejoin and vote (the vote
 * wrote, then the read-back answered 404), and the room stayed in their list
 * with its last message. Driven on staging first: the event 404'd while its
 * history, roster and chat answered 200. One predicate now, real rows here.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const messages = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const reactions = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route")
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
const groups = require("@/app/api/mobile/chat/groups/route") as typeof import("@/app/api/mobile/chat/groups/route")
const { castVote } = require("@/lib/polls") as typeof import("@/lib/polls")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
let eventId = ""
let groupId = ""
let memberId = ""
let token = ""
let hostMessage = ""
let pollId = ""
let options: string[] = []

afterAll(async () => {
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

const req = (url: string, method = "GET", body?: object) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const post = (content: string) =>
  messages.POST(req(`/api/mobile/chat/groups/${groupId}/messages`, "POST", { content, type: "text" }), {
    params: Promise.resolve({ chatGroupId: groupId }),
  })

async function listed(): Promise<boolean> {
  const res = await groups.GET(req("/api/mobile/chat/groups"))
  const body = (await res.json()) as { data: { groups: { id: string }[] } }
  return body.data.groups.some((g) => g.id === groupId)
}

beforeAll(async () => {
  const host = await makeUser(testId("derc-host"), "organizer")
  memberId = await makeUser(testId("derc-member"))
  users.push(host, memberId)
  eventId = await makeEvent(host)
  events.push(eventId)
  groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })).id
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: memberId, status: "active", anonymous_name: testId("Heron") } })
  hostMessage = (await db.chat_messages.create({ data: { chat_group_id: groupId, user_id: host, content: "doors at 7" }, select: { id: true } })).id
  const pollMessage = await db.chat_messages.create({ data: { chat_group_id: groupId, user_id: host, content: "Which talk?" }, select: { id: true } })
  const poll = await db.chat_polls.create({
    data: { message_id: pollMessage.id, question: "Which talk?", options: { create: [{ label: "A", position: 0 }, { label: "B", position: 1 }] } },
    select: { id: true, options: { select: { id: true }, orderBy: { position: "asc" } } },
  })
  pollId = poll.id
  options = poll.options.map((o) => o.id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id: memberId }, select: { email: true } })
  token = await signAccessToken(memberId, email)

  // While the event stands, every door is open — so each refusal below is the delete's.
  expect((await post("before the delete")).status).toBe(201)
  await castVote(pollId, options[0], memberId, eventId)
  expect(await listed()).toBe(true)

  await db.events.update({ where: { id: eventId }, data: { deleted_at: new Date() } })
})

it("refuses a post on both send routes, and writes nothing", async () => {
  const before = await db.chat_messages.count({ where: { chat_group_id: groupId } })
  const viaGroup = await post("after the delete")
  expect(viaGroup.status).toBe(403)
  expect((await viaGroup.json()).error).toBe("This event is no longer available.")
  const viaEvent = await eventChat.POST(req(`/api/mobile/events/${eventId}/chat`, "POST", { content: "after the delete", type: "text" }), {
    params: Promise.resolve({ eventId }),
  })
  expect(viaEvent.status).toBe(403)
  expect(await db.chat_messages.count({ where: { chat_group_id: groupId } })).toBe(before)
})

it("refuses a reaction, and writes none", async () => {
  const res = await reactions.POST(req(`/api/mobile/chat/groups/${groupId}/messages/${hostMessage}/reactions`, "POST", { emoji: "👍" }), {
    params: Promise.resolve({ chatGroupId: groupId, messageId: hostMessage }),
  })
  expect(res.status).toBe(403)
  expect(await db.message_reactions.count({ where: { message_id: hostMessage } })).toBe(0)
})

it("refuses a changed vote, and leaves the one cast before the delete", async () => {
  await expect(castVote(pollId, options[1], memberId, eventId)).rejects.toThrow("The chatroom is not open")
  const votes = await db.chat_poll_votes.findMany({ where: { poll_id: pollId }, select: { option_id: true } })
  expect(votes).toEqual([{ option_id: options[0] }])
})

it("drops the room from the member's conversation list", async () => {
  expect(await listed()).toBe(false)
})
