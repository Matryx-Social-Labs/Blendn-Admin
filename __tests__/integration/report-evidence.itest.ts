import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefgh"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { conversationPair } from "@/lib/conversations"
import { purgeClosedLobbies } from "@/lib/lobby-retention"
import { signAccessToken } from "@/lib/mobile-auth"
import { recentLines } from "@/lib/report-evidence"
import { reportReason } from "@/lib/report-reasons"
import { roomHandle } from "@/lib/room-handle"
import { exportUser } from "@/scripts/export-user"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard } from "./helpers"

/*
 * A report keeps the reported words (SCRUM-1176): a message report copies the
 * message into `excerpt`, a person report made from a room or a DM copies that
 * person's last lines there. The copy outlives the message, is never returned to
 * the reporter, and goes with the dismissed-report sweep.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const messageReport = require("@/app/api/mobile/messages/[messageId]/report/route") as typeof import("@/app/api/mobile/messages/[messageId]/report/route")
const userReport = require("@/app/api/mobile/users/[userId]/report/route") as typeof import("@/app/api/mobile/users/[userId]/report/route")
const leave = require("@/app/api/mobile/conversations/[conversationId]/leave/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/leave/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
type Person = { id: string; token: string }

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string): Promise<Person> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

const post = (h: unknown, as: Person, params: Record<string, string>, body: unknown) =>
  (h as Handler)(
    new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) as Promise<never> }
  )

/** Ana reports, Ben is reported, Cy is also in the room. Ben wrote 22 lines in the room, Cy one, Ana one. */
async function world(label: string) {
  const [ana, ben, cy] = [await person(`${label}_a`), await person(`${label}_b`), await person(`${label}_c`)]
  const eventId = await makeEvent(ana.id)
  events.push(eventId)
  const room = await db.chat_groups.create({ data: { event_id: eventId, name: "evidence room" } })
  await db.chat_group_members.createMany({ data: [ana, ben, cy].map((p) => ({ chat_group_id: room.id, user_id: p.id })) })
  const t0 = Date.now() - 60 * 60 * 1000
  const lines = Array.from({ length: 22 }, (_, i) => `ben line ${i + 1}`)
  await db.chat_messages.createMany({
    data: [
      ...lines.map((content, i) => ({ chat_group_id: room.id, user_id: ben.id, content, created_at: new Date(t0 + i * 1000) })),
      { chat_group_id: room.id, user_id: cy.id, content: "cy says hi", created_at: new Date(t0 + 30_000) },
      { chat_group_id: room.id, user_id: ana.id, content: "ana says stop", created_at: new Date(t0 + 31_000) },
    ],
  })
  const threat = await db.chat_messages.create({
    data: { chat_group_id: room.id, user_id: ben.id, content: "I know where you live", created_at: new Date(t0 + 40_000) },
  })
  const [user1_id, user2_id] = conversationPair(ana.id, ben.id)
  const dm = await db.private_conversations.create({ data: { user1_id, user2_id, user1_pseudonym: "Otter", user2_pseudonym: "Heron" } })
  await db.private_messages.create({ data: { conversation_id: dm.id, sender_id: ana.id, message_text: "please leave me alone", created_at: new Date(t0) } })
  const dmLine = await db.private_messages.create({
    data: { conversation_id: dm.id, sender_id: ben.id, message_text: "send me a photo or else", created_at: new Date(t0 + 1000) },
  })
  return { ana, ben, cy, eventId, room: room.id, threat: threat.id, dm: dm.id, dmLine: dmLine.id }
}

describe("a message report keeps the words", () => {
  it("copies a room message into excerpt, and the excerpt outlives the message", async () => {
    const w = await world("mr_room")
    const res = await post(messageReport.POST, w.ana, { messageId: w.threat }, { messageType: "group", reason: "threat" })
    expect(res.status).toBe(201)
    expect(JSON.stringify(await res.json())).not.toContain("I know where you live")

    await db.chat_messages.delete({ where: { id: w.threat } })
    const row = await db.message_reports.findFirstOrThrow({ where: { reporter_id: w.ana.id, message_id: w.threat } })
    expect(row).toMatchObject({ reason: "threat", excerpt: "I know where you live" })
  })

  it("copies a DM message into excerpt, and the excerpt outlives the message", async () => {
    const w = await world("mr_dm")
    expect((await post(messageReport.POST, w.ana, { messageId: w.dmLine }, { messageType: "private", reason: "intimate_image" })).status).toBe(201)

    await db.private_messages.delete({ where: { id: w.dmLine } })
    const row = await db.message_reports.findFirstOrThrow({ where: { reporter_id: w.ana.id, message_id: w.dmLine } })
    expect(row).toMatchObject({ reason: "intimate_image", excerpt: "send me a photo or else" })
  })

  it("files a free-text reason from an older app as it was written, read as other", async () => {
    const w = await world("mr_free")
    const reason = "he kept going after I said stop"
    expect((await post(messageReport.POST, w.ana, { messageId: w.threat }, { messageType: "group", reason })).status).toBe(201)
    const row = await db.message_reports.findFirstOrThrow({ where: { reporter_id: w.ana.id, message_id: w.threat } })
    expect(row.reason).toBe(reason)
    expect(reportReason(row.reason)).toBe("other")
  })

  it("copies the DM message a Block-and-report points at", async () => {
    const w = await world("mr_leave")
    const res = await post(leave.POST, w.ana, { conversationId: w.dm }, { action: "block", report: { reason: "harassment", messageId: w.dmLine } })
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).not.toContain("send me a photo")
    const row = await db.message_reports.findFirstOrThrow({ where: { reporter_id: w.ana.id, message_id: w.dmLine } })
    expect(row.excerpt).toBe("send me a photo or else")
  })
})

describe("a person report from a room or a DM keeps their last lines there", () => {
  const ben21to22AndThreat = [...Array.from({ length: 19 }, (_, i) => `ben line ${i + 4}`), "I know where you live"].join("\n")

  it("by their room handle: their last 20 lines in that room, oldest first, nobody else's", async () => {
    const w = await world("ur_room")
    const res = await post(userReport.POST, w.ana, { userId: roomHandle(w.eventId, w.ben.id) }, { reason: "harassment" })
    expect(res.status).toBe(201)
    expect(JSON.stringify(await res.json())).not.toContain("ben line")

    await db.chat_messages.deleteMany({ where: { chat_group_id: w.room, user_id: w.ben.id } })
    const row = await db.user_reports.findFirstOrThrow({ where: { reporter_id: w.ana.id, reported_id: w.ben.id } })
    expect(row.excerpt).toBe(ben21to22AndThreat)
  })

  it("by their DM handle: their lines in that conversation", async () => {
    const w = await world("ur_dm")
    const ref = roomHandle({ kind: "dm", groupId: w.dm }, w.ben.id)
    expect((await post(userReport.POST, w.ana, { userId: ref }, { reason: "under_18" })).status).toBe(201)
    const row = await db.user_reports.findFirstOrThrow({ where: { reporter_id: w.ana.id, reported_id: w.ben.id } })
    expect(row).toMatchObject({ reason: "under_18", excerpt: "send me a photo or else" })
  })

  it("by Unmatch-and-report with no message: their lines in that conversation", async () => {
    const w = await world("ur_leave")
    expect((await post(leave.POST, w.ana, { conversationId: w.dm }, { action: "unmatch", report: { reason: "other" } })).status).toBe(200)
    const row = await db.user_reports.findFirstOrThrow({ where: { reporter_id: w.ana.id, reported_id: w.ben.id } })
    expect(row.excerpt).toBe("send me a photo or else")
  })

  it("by a raw id, from no room: no excerpt", async () => {
    const w = await world("ur_raw")
    expect((await post(userReport.POST, w.ana, { userId: w.ben.id }, { reason: "spam" })).status).toBe(201)
    const row = await db.user_reports.findFirstOrThrow({ where: { reporter_id: w.ana.id, reported_id: w.ben.id } })
    expect(row.excerpt).toBeNull()
  })

  it("copies nothing from a room the reporter is not in", async () => {
    const w = await world("ur_out")
    const outsider = await person("ur_out_x")
    expect(await recentLines(outsider.id, w.ben.id, { chatGroupId: w.room })).toBeNull()
    expect(await recentLines(outsider.id, w.ben.id, { eventId: w.eventId })).toBeNull()
    expect(await recentLines(outsider.id, w.ben.id, { conversationId: w.dm })).toBeNull()
    expect(await recentLines(w.ana.id, w.ben.id, { chatGroupId: w.room })).toBe(ben21to22AndThreat)
  })

  it("bounds each line", async () => {
    const w = await world("ur_long")
    await db.chat_messages.create({ data: { chat_group_id: w.room, user_id: w.ben.id, content: "x".repeat(4000) } })
    const lines = (await recentLines(w.ana.id, w.ben.id, { chatGroupId: w.room }))!.split("\n")
    expect(lines).toHaveLength(20)
    expect(lines[19].length).toBeLessThanOrEqual(500)
  })
})

describe("who reads an excerpt", () => {
  it("is never in the reporter's own data export", async () => {
    const w = await world("ex")
    await post(messageReport.POST, w.ana, { messageId: w.dmLine }, { messageType: "private", reason: "threat" })
    await post(userReport.POST, w.ana, { userId: roomHandle(w.eventId, w.ben.id) }, { reason: "harassment" })
    expect(await db.message_reports.count({ where: { reporter_id: w.ana.id, excerpt: { not: null } } })).toBe(1)
    expect(await db.user_reports.count({ where: { reporter_id: w.ana.id, excerpt: { not: null } } })).toBe(1)

    const out = JSON.stringify(await exportUser(db, w.ana.id))
    expect(out).not.toContain("excerpt")
    expect(out).not.toContain("send me a photo")
    expect(out).not.toContain("ben line")
  })
})

describe("the dismissed-report sweep", () => {
  it("takes a dismissed person report's excerpt and description at 180 days, and keeps a pending one's", async () => {
    process.env.LOBBY_PURGE = "delete"
    const w = await world("sweep")
    const old = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000)
    const dismissed = await db.user_reports.create({
      data: { reporter_id: w.ana.id, reported_id: w.ben.id, reason: "spam", description: "d", excerpt: "e", status: "reviewed", reviewed_at: old },
    })
    const pending = await db.user_reports.create({
      data: { reporter_id: w.ana.id, reported_id: w.ben.id, reason: "spam", description: "d", excerpt: "e" },
    })
    await purgeClosedLobbies(new Date())
    expect(await db.user_reports.findUniqueOrThrow({ where: { id: dismissed.id } })).toMatchObject({ excerpt: null, description: null })
    expect(await db.user_reports.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ excerpt: "e", description: "d" })
  })
})
