import { NextRequest } from "next/server"

/*
 * Opening an event's room says whether the organiser locked it (S-12).
 *
 * `write.reason` is the caller's own answer and names a mute or a ban before
 * the lock, so a muted member opening a locked room was told "muted" and the
 * app could not show the lock. `status` is the room's state for everybody in
 * it. Real route, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  if (events.length) await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function member(groupId: string, label: string, status: "active" | "muted") {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: id, status, anonymous_name: testId("Heron") } })
  return id
}

async function open(eventId: string, userId: string) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const res = await eventChat.GET(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/chat`, { headers: { authorization: `Bearer ${signAccessToken(userId, email)}` } }),
    { params: Promise.resolve({ eventId }) }
  )
  expect(res.status).toBe(200)
  return (await res.json()).data as { status: string; write: { allowed: boolean; reason: string | null } }
}

it("says `locked` to everyone in a locked room, a muted member included, and `active` once it is reopened", async () => {
  const host = await makeUser(testId("rso-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "locked" }, select: { id: true } })
  const active = await member(group.id, "rso-active", "active")
  const muted = await member(group.id, "rso-muted", "muted")

  const a = await open(eventId, active)
  expect([a.status, a.write.allowed]).toEqual(["locked", false])
  const m = await open(eventId, muted)
  // Their own answer is the mute; the room's is the lock.
  expect(m.status).toBe("locked")
  expect(m.write.reason).not.toBe("locked")

  await db.chat_groups.update({ where: { id: group.id }, data: { status: "active" } })
  expect((await open(eventId, active)).status).toBe("active")
})
