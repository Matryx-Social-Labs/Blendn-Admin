import { NextRequest } from "next/server"

/*
 * A poll is read by the room it was posted in, and nobody else (SCRUM-298).
 *
 * Driven on staging: admin@ posted a poll in Founders & Filter Coffee's room,
 * and `GET /events/:eventId/polls/:pollId` answered 200 with the question and
 * options to somebody who had never been in the room, to a member the
 * organiser had banned, and with an unrelated event id in the URL. The vote
 * was refused; only the read was open. `getPollResults` loaded the poll by id
 * alone. The room's own reads have refused the same people since SCRUM-205.
 * Real routes, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
// poll-actions also holds createPoll, a dashboard action; the mobile routes never touch the session.
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pollRoute = require("@/app/api/mobile/events/[eventId]/polls/[pollId]/route") as typeof import("@/app/api/mobile/events/[eventId]/polls/[pollId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const voteRoute = require("@/app/api/mobile/events/[eventId]/polls/[pollId]/vote/route") as typeof import("@/app/api/mobile/events/[eventId]/polls/[pollId]/vote/route")

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  if (events.length) await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

const QUESTION = "which coffee"

async function tokenFor(userId: string) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  return signAccessToken(userId, email)
}

/** A live event, its open room, and a poll posted in it by the host. */
async function roomWithPoll(label: string) {
  const host = await makeUser(testId(`${label}-host`), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  // Live now, so the room's window is open and a vote could land.
  await db.events.update({
    where: { id: eventId },
    data: { start_time: new Date(Date.now() - 3600_000), end_time: new Date(Date.now() + 3600_000) },
  })
  const group = await db.chat_groups.create({
    data: { event_id: eventId, name: "room", status: "active" },
    select: { id: true },
  })
  const message = await db.chat_messages.create({
    data: { chat_group_id: group.id, user_id: host, type: "poll", content: QUESTION, metadata: { poll: true } },
    select: { id: true },
  })
  const poll = await db.chat_polls.create({
    data: {
      message_id: message.id,
      question: QUESTION,
      closes_at: new Date(Date.now() + 1800_000),
      results_visible: true,
      options: { create: [{ label: "Filter", position: 0 }, { label: "Espresso", position: 1 }] },
    },
    select: { id: true, options: { select: { id: true }, orderBy: { position: "asc" } } },
  })
  return { host, eventId, groupId: group.id, messageId: message.id, pollId: poll.id, optionId: poll.options[0].id }
}

async function person(label: string, room?: { groupId: string; status: "active" | "muted" | "banned" | "left"; bannedBy?: string }) {
  const id = await makeUser(testId(label))
  users.push(id)
  if (room) {
    await db.chat_group_members.create({
      data: {
        chat_group_id: room.groupId,
        user_id: id,
        status: room.status,
        anonymous_name: testId("Heron"),
        ...(room.status === "banned" ? { banned_at: new Date(), banned_by: room.bannedBy ?? null } : {}),
      },
    })
  }
  return id
}

async function read(eventId: string, pollId: string, userId: string) {
  const token = await tokenFor(userId)
  return pollRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/polls/${pollId}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ eventId, pollId }) }
  )
}

async function vote(eventId: string, pollId: string, optionId: string, userId: string) {
  const token = await tokenFor(userId)
  return voteRoute.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/polls/${pollId}/vote`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ optionId }),
    }),
    { params: Promise.resolve({ eventId, pollId }) }
  )
}

it("refuses somebody who was never in the room, and says nothing about the poll", async () => {
  const r = await roomWithPoll("prg-outsider")
  const outsider = await person("prg-outsider")

  const res = await read(r.eventId, r.pollId, outsider)
  const body = await res.json()
  expect(res.status).toBe(403)
  expect(JSON.stringify(body)).not.toContain(QUESTION)
})

it("refuses a member the organiser banned, with the room's own sentence", async () => {
  const r = await roomWithPoll("prg-banned")
  const banned = await person("prg-banned", { groupId: r.groupId, status: "banned", bannedBy: r.host })

  const res = await read(r.eventId, r.pollId, banned)
  expect(res.status).toBe(403)
  expect((await res.json()).error).toBe("The organiser has removed you from this room.")
})

it("answers 404 when the URL names a different event, even to a member of the poll's room", async () => {
  const r = await roomWithPoll("prg-wrong-event")
  const member = await person("prg-wrong-member", { groupId: r.groupId, status: "active" })
  const other = await makeEvent(r.host)
  events.push(other)

  const res = await read(other, r.pollId, member)
  expect(res.status).toBe(404)
  expect(JSON.stringify(await res.json())).not.toContain(QUESTION)
})

it("does not take a vote through a URL that names a different event", async () => {
  const r = await roomWithPoll("prg-wrong-vote")
  const member = await person("prg-wrong-voter", { groupId: r.groupId, status: "active" })
  const other = await makeEvent(r.host)
  events.push(other)

  const res = await vote(other, r.pollId, r.optionId, member)
  expect(res.status).toBe(404)
  expect(await db.chat_poll_votes.count({ where: { poll_id: r.pollId } })).toBe(0)
})

it("hides a poll whose message was deleted, and a draft event's poll, from their own members", async () => {
  const r = await roomWithPoll("prg-hidden")
  const member = await person("prg-hidden-member", { groupId: r.groupId, status: "active" })

  await db.chat_messages.update({ where: { id: r.messageId }, data: { deleted_at: new Date() } })
  expect((await read(r.eventId, r.pollId, member)).status).toBe(404)

  await db.chat_messages.update({ where: { id: r.messageId }, data: { deleted_at: null } })
  await db.events.update({ where: { id: r.eventId }, data: { status: "draft" } })
  expect((await read(r.eventId, r.pollId, member)).status).toBe(404)
})

it("still serves the poll to an active, a muted and a left member, and takes an active member's vote", async () => {
  const r = await roomWithPoll("prg-members")
  for (const status of ["active", "muted", "left"] as const) {
    const who = await person(`prg-${status}`, { groupId: r.groupId, status })
    const res = await read(r.eventId, r.pollId, who)
    expect(res.status).toBe(200)
    expect((await res.json()).data.question).toBe(QUESTION)
  }

  const voter = await person("prg-voter", { groupId: r.groupId, status: "active" })
  const res = await vote(r.eventId, r.pollId, r.optionId, voter)
  expect(res.status).toBe(200)
  expect(await db.chat_poll_votes.count({ where: { poll_id: r.pollId, user_id: voter } })).toBe(1)
})
