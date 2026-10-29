import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => (session?.user ? { ...session, user: { signedInAt: 0, ...session.user } } : session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { NextRequest } from "next/server"

import { PATCH as moderateMember } from "@/app/api/events/[id]/chat/members/[userId]/route"
import { roomHandle } from "@/lib/room-handle"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/*
 * SCRUM-522: unban and unmute wrote `active` over whatever the member was
 * before. Banning and unbanning somebody who had left (or whose room had
 * ended) put them back in the room. A member who left, by choice or because
 * the room closed, comes out of an unban or an unmute as they went in.
 */
const users: string[] = []
const events: string[] = []
let host = ""
let eventId = ""
let groupId = ""

const patch = (target: string, action: string) =>
  moderateMember(
    new NextRequest(`http://localhost/api/events/${eventId}/chat/members/${roomHandle(eventId, target)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id: eventId, userId: roomHandle(eventId, target) }) }
  )

async function member(label: string, data: { status?: "active" | "left"; left_at?: Date }) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: id, anonymous_name: label, ...data } })
  return id
}
const statusOf = async (id: string) =>
  (await db.chat_group_members.findUniqueOrThrow({ where: { chat_group_id_user_id: { chat_group_id: groupId, user_id: id } } })).status

beforeAll(async () => {
  host = await makeUser(testId("ukl-host"), "organizer")
  users.push(host)
  session = { user: { id: host, role: "organizer" } }
  eventId = await makeEvent(host)
  events.push(eventId)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("ukl-org"), status: "verified" } })
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner" } })
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })
  groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "Room" }, select: { id: true } })).id
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: host, role: "admin" } })
})

afterAll(async () => {
  await db.chat_group_members.deleteMany({ where: { chat_group_id: groupId } })
  await db.organisation_members.deleteMany({ where: { user_id: host } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { display_name: { startsWith: "ukl-org" } } })
  await closeDb()
})

describe("unban and unmute put a member back as they were", () => {
  it("an active member comes back active (control)", async () => {
    const id = await member("ukl-a", {})
    expect((await patch(id, "ban")).status).toBe(200)
    expect(await statusOf(id)).toBe("banned")
    expect((await patch(id, "unban")).status).toBe(200)
    expect(await statusOf(id)).toBe("active")
    await patch(id, "mute")
    await patch(id, "unmute")
    expect(await statusOf(id)).toBe("active")
  })

  it("a member who left by choice stays left through ban and unban, and through mute and unmute", async () => {
    const id = await member("ukl-b", { status: "left", left_at: new Date(Date.now() - 3600_000) })
    await patch(id, "ban")
    expect(await statusOf(id)).toBe("banned")
    expect((await patch(id, "unban")).status).toBe(200)
    expect(await statusOf(id)).toBe("left")
    await patch(id, "mute")
    await patch(id, "unmute")
    expect(await statusOf(id)).toBe("left")
  })

  it("a member of a room that has ended (archived) stays left", async () => {
    const id = await member("ukl-c", { status: "left" })
    await db.chat_groups.update({ where: { id: groupId }, data: { status: "archived" } })
    try {
      await patch(id, "ban")
      await patch(id, "unban")
      expect(await statusOf(id)).toBe("left")
    } finally {
      await db.chat_groups.update({ where: { id: groupId }, data: { status: "active" } })
    }
  })
})
