import { NextRequest } from "next/server"

/*
 * A message posted through each send route, against a real database.
 *
 * Both routes returned 500 on a plain text message and nothing in the tree
 * could see it: the group route wrote `metadata: metadata || undefined`, the
 * event route wrote `metadata as … | undefined` and `parent_id: parentId` —
 * three shapes of explicit undefined, two of which no regex matches, all of
 * which `strictUndefinedChecks` refuses at runtime. Found by sending one
 * message from a phone, then by curl. This is the check that would have found
 * it first: post, read the row.
 *
 * And the policy decided on 2026-09-12: a message with contact details is
 * hidden on write in a room — the sender is told, the row is flagged, nobody
 * else is served it — on both routes, without counting toward an auto-mute.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as
  typeof import("@/app/api/mobile/events/[eventId]/chat/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  if (events.length) {
    const groups = await db.chat_groups.findMany({ where: { event_id: { in: events } }, select: { id: true } })
    const groupIds = groups.map((g) => g.id)
    if (groupIds.length) {
      await db.moderation_flags.deleteMany({ where: { chat_group_id: { in: groupIds } } })
      await db.chat_messages.deleteMany({ where: { chat_group_id: { in: groupIds } } })
      await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: groupIds } } })
      await db.chat_groups.deleteMany({ where: { id: { in: groupIds } } })
    }
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function liveRoom() {
  const owner = await makeUser(testId("rs_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("rs"),
      title: `Room ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(now - HOUR),
      end_time: new Date(now + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
  })
  const group = await db.chat_groups.create({ data: { event_id: event.id, name: "room", status: "active" } })
  const memberId = await makeUser(testId("rs_m"))
  users.push(memberId)
  const user = await db.user.findUniqueOrThrow({ where: { id: memberId }, select: { email: true } })
  await db.chat_group_members.create({
    data: { chat_group_id: group.id, user_id: memberId, anonymous_name: `Pseudo ${testId("x")}` },
  })
  return { eventId: event.id, groupId: group.id, memberId, token: signAccessToken(memberId, user.email) }
}

const post = (url: string, token: string, body: object) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

async function viaGroup(r: Awaited<ReturnType<typeof liveRoom>>, content: string) {
  const res = await groupRoute.POST(
    post(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, r.token, { content, type: "text" }),
    { params: Promise.resolve({ chatGroupId: r.groupId }) }
  )
  return { status: res.status, body: (await res.json()) as { data?: { id?: string; moderation_hidden?: boolean } } }
}

async function viaEvent(r: Awaited<ReturnType<typeof liveRoom>>, content: string) {
  const res = await eventRoute.POST(
    post(`http://localhost/api/mobile/events/${r.eventId}/chat`, r.token, { content, type: "text" }),
    { params: Promise.resolve({ eventId: r.eventId }) }
  )
  return {
    status: res.status,
    body: (await res.json()) as { data?: { message?: { id?: string; moderation_hidden?: boolean } } },
  }
}

describe("a plain message, with no metadata and no parent", () => {
  it("is written by the group route", async () => {
    const r = await liveRoom()
    const { status, body } = await viaGroup(r, "anyone at the bar")
    expect(status).toBe(201)
    const row = await db.chat_messages.findUniqueOrThrow({ where: { id: body.data!.id! } })
    expect(row.content).toBe("anyone at the bar")
    expect(row.deleted_at).toBeNull()
  })

  it("is written by the event route", async () => {
    const r = await liveRoom()
    const { status, body } = await viaEvent(r, "anyone at the bar")
    expect(status).toBe(201)
    const row = await db.chat_messages.findUniqueOrThrow({ where: { id: body.data!.message!.id! } })
    expect(row.content).toBe("anyone at the bar")
    expect(row.parent_id).toBeNull()
  })
})

describe("contact details in a room", () => {
  for (const [name, send] of [
    ["group route", viaGroup],
    ["event route", viaEvent],
  ] as const) {
    it(`are hidden on write and flagged, on the ${name}`, async () => {
      const r = await liveRoom()
      const { status, body } = await send(r, "call me on 98765 43210 tonight")
      // Accepted (the pre-save hide answers 200, the ordinary write 201).
      expect([200, 201]).toContain(status)
      const data = "message" in (body.data ?? {}) ? (body.data as { message: { id: string; moderation_hidden: boolean } }).message : (body.data as { id: string; moderation_hidden: boolean })
      // The sender is told.
      expect(data.moderation_hidden).toBe(true)
      // The row is hidden and flagged for a human — never auto-muted for it.
      const row = await db.chat_messages.findUniqueOrThrow({ where: { id: data.id } })
      expect(row.moderation_status).toBe("hidden")
      expect(row.deleted_at).not.toBeNull()
      // The flag is written fire-and-forget after the response; give it a moment.
      let flag = null
      for (let i = 0; i < 20 && !flag; i++) {
        flag = await db.moderation_flags.findFirst({ where: { message_id: data.id } })
        if (!flag) await new Promise((r) => setTimeout(r, 100))
      }
      expect(flag?.status).toBe("pending")
      expect(flag?.categories).toMatchObject({ contact_phone: 1 })
      const membership = await db.chat_group_members.findFirstOrThrow({
        where: { chat_group_id: r.groupId, user_id: r.memberId },
      })
      expect(membership.status).toBe("active")
      // And the history serves the sender a placeholder, not the number.
      const history = await groupRoute.GET(
        new NextRequest(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, {
          headers: { authorization: `Bearer ${r.token}` },
        }),
        { params: Promise.resolve({ chatGroupId: r.groupId }) }
      )
      const served = ((await history.json()) as { data: { messages: { id: string; content: string | null; moderation_hidden: boolean }[] } }).data.messages
      const mine = served.find((m) => m.id === data.id)
      expect(mine).toMatchObject({ content: null, moderation_hidden: true })
    })
  }
})
