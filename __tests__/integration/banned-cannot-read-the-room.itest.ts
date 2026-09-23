import { NextRequest } from "next/server"

/*
 * A ban removes somebody from the room — reading included (SCRUM-205).
 *
 * Driven on staging: Arjun banned Cosmic Panda from the dashboard's Members
 * tab, the row read `banned`, and `GET /chat/groups/:id/messages` with her
 * own token answered 200 with the room's last five messages. The socket had
 * refused a banned member since it had a join check; the three HTTP reads
 * checked only that a membership row existed. Real routes, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const messages = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const participants = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  if (events.length) await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function tokenFor(userId: string) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  return signAccessToken(userId, email)
}

const get = (url: string, token: string) =>
  new NextRequest(`http://localhost${url}`, { headers: { authorization: `Bearer ${token}` } })

async function room(host: string) {
  const eventId = await makeEvent(host)
  events.push(eventId)
  const group = await db.chat_groups.create({
    data: { event_id: eventId, name: "room", status: "active" },
    select: { id: true },
  })
  await db.chat_messages.create({
    data: { chat_group_id: group.id, user_id: host, content: "who is doing the talk at 4" },
  })
  return { eventId, groupId: group.id }
}

async function member(groupId: string, label: string, status: "active" | "muted" | "banned" | "left", bannedBy: string | null = null) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.chat_group_members.create({
    data: {
      chat_group_id: groupId,
      user_id: id,
      status,
      anonymous_name: testId("Heron"),
      ...(status === "banned" ? { banned_at: new Date(), banned_by: bannedBy } : {}),
    },
  })
  return id
}

const readAll = async (groupId: string, eventId: string, userId: string) => {
  const token = await tokenFor(userId)
  const ctx = { params: Promise.resolve({ chatGroupId: groupId }) }
  return {
    messages: await messages.GET(get(`/api/mobile/chat/groups/${groupId}/messages`, token), ctx),
    participants: await participants.GET(get(`/api/mobile/chat/groups/${groupId}/participants`, token), ctx),
    eventChat: await eventChat.GET(get(`/api/mobile/events/${eventId}/chat`, token), {
      params: Promise.resolve({ eventId }),
    }),
  }
}

it("refuses all three reads to a member an organiser banned, and says who did it", async () => {
  const host = await makeUser(testId("bcr-host"), "organizer")
  users.push(host)
  const { eventId, groupId } = await room(host)
  const banned = await member(groupId, "bcr-banned", "banned", host)

  const res = await readAll(groupId, eventId, banned)
  for (const r of Object.values(res)) {
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBe("The organiser has removed you from this room.")
  }
})

it("names the pipeline, not the organiser, when nobody pressed Ban", async () => {
  const host = await makeUser(testId("bcr-host2"), "organizer")
  users.push(host)
  const { eventId, groupId } = await room(host)
  const auto = await member(groupId, "bcr-auto", "banned", null)

  const { messages: r } = await readAll(groupId, eventId, auto)
  expect(r.status).toBe(403)
  expect((await r.json()).error).toMatch(/after repeated policy violations/)
})

it("still serves the room to an active, a muted and a left member", async () => {
  const host = await makeUser(testId("bcr-host3"), "organizer")
  users.push(host)
  const { groupId } = await room(host)
  for (const status of ["active", "muted", "left"] as const) {
    const who = await member(groupId, `bcr-${status}`, status)
    const token = await tokenFor(who)
    const r = await messages.GET(get(`/api/mobile/chat/groups/${groupId}/messages`, token), {
      params: Promise.resolve({ chatGroupId: groupId }),
    })
    expect(r.status).toBe(200)
    expect((await r.json()).data.messages.map((m: { content: string }) => m.content)).toContain(
      "who is doing the talk at 4"
    )
  }
})

it("hides a draft event's room from its own members", async () => {
  const host = await makeUser(testId("bcr-host4"), "organizer")
  users.push(host)
  const { eventId, groupId } = await room(host)
  const who = await member(groupId, "bcr-draft", "active")
  await db.events.update({ where: { id: eventId }, data: { status: "draft" } })

  const res = await readAll(groupId, eventId, who)
  expect(res.messages.status).toBe(404)
  expect(res.participants.status).toBe(404)
  expect(res.eventChat.status).toBe(404)
})
