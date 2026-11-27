/*
 * Direct messages 180 days after their conversation closed (SCRUM-1237,
 * register D-029), against real rows. A conversation closes on an unmatch, a
 * block, or either person's account deletion, and never reopens; from then on
 * nobody reads it in the app. 180 days on its messages go, with their photos,
 * unless a report holds them: pending until it is decided, upheld for 180 days
 * from the decision. An open conversation is never touched, whatever its age.
 * The conversation row stays. Storage is the one fake.
 */
const mockDeleteFile = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  isConfigured: () => true,
  deleteFile: (...a: unknown[]) => mockDeleteFile(...a),
}))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { inboxCountsFor } from "@/lib/badge-count"
import { purgeClosedConversations } from "@/lib/dm-retention"
import { logger } from "@/lib/logger"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const conversations = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const BUCKET = "https://blendn-media-private.fly.storage.tigris.dev"

const users: string[] = []
let author = ""
let survivor = ""
let reporter = ""
const conv: Record<string, string> = {}
const msg: Record<string, string> = {}
let ownPhoto = ""
const sealedPhoto = `chat/sealed/${randomUUID()}`
let warned: unknown[][] = []

afterAll(async () => {
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

/** A conversation between two people, closed `closedDaysAgo` days ago (null: open), its messages written before. */
async function conversation(a: string, b: string, closedDaysAgo: number | null) {
  const [user1_id, user2_id] = [a, b].sort()
  const created = ago((closedDaysAgo ?? 0) + 400)
  return (
    await db.private_conversations.create({
      data: {
        user1_id,
        user2_id,
        created_at: created,
        last_message_at: created,
        ...(closedDaysAgo !== null && { closed_at: ago(closedDaysAgo), closed_by: a, closed_reason: "account_deleted" }),
      },
      select: { id: true },
    })
  ).id
}

const write = async (conversation_id: string, extra: object = {}, sender_id = author) =>
  (await db.private_messages.create({ data: { conversation_id, sender_id, message_text: "hello", created_at: ago(500), ...extra }, select: { id: true } })).id

const report = (message_id: string, extra: object = {}) =>
  db.message_reports.create({ data: { reporter_id: reporter, message_id, message_type: "private", reason: "harassment", excerpt: "hello", ...extra } })

const left = async (ids: string[]) => (await db.private_messages.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((m) => m.id)

beforeAll(async () => {
  author = await makeUser(testId("dmr-author"))
  survivor = await makeUser(testId("dmr-survivor"))
  reporter = await makeUser(testId("dmr-reporter"))
  const others = await Promise.all(["a", "b", "c", "d"].map((l) => makeUser(testId(`dmr-other-${l}`))))
  users.push(author, survivor, reporter, ...others)
  ownPhoto = `chat/${author}/1758000000000-${randomUUID().slice(0, 6)}-photo.jpg`
  await onboard(author, survivor, reporter, ...others)

  // Closed 181 days ago (the author deleted their account): past its time.
  conv.past = await conversation(author, survivor, 181)
  msg.plain = await write(conv.past)
  msg.reply = await write(conv.past, { sender_id: survivor }, survivor)
  msg.ownPhoto = await write(conv.past, { message_text: null, media_url: `${BUCKET}/${ownPhoto}`, media_type: "image" })
  msg.sealedPhoto = await write(conv.past, { message_text: null, media_url: `${BUCKET}/${sealedPhoto}`, media_type: "image" })
  msg.outsidePhoto = await write(conv.past, { message_text: null, media_url: "https://images.example.com/chat/x/photo.jpg", media_type: "image" })
  // Reports on messages in it: pending holds, upheld inside 180 days holds, the rest do not.
  msg.pending = await write(conv.past)
  await report(msg.pending)
  msg.upheldRecently = await write(conv.past)
  await report(msg.upheldRecently, { status: "resolved", reviewed_at: ago(10) })
  msg.upheldLongAgo = await write(conv.past)
  await report(msg.upheldLongAgo, { status: "resolved", reviewed_at: ago(181) })
  msg.dismissed = await write(conv.past)
  await report(msg.dismissed, { status: "reviewed", reviewed_at: ago(5) })
  // A report on a room message with the same id shape holds nothing here.
  msg.groupReported = await write(conv.past)
  await report(msg.groupReported, { message_type: "group" })

  // Closed 179 days ago: inside the window.
  conv.inside = await conversation(author, others[0], 179)
  msg.inside = await write(conv.inside)
  // Open, and old: never touched.
  conv.open = await conversation(author, others[1], null)
  msg.open = await write(conv.open, { created_at: ago(900) })
  // A second conversation past its time, of one message under a pending report (the drive's shape).
  conv.reported = await conversation(author, others[2], 200)
  msg.reportedOnly = await write(conv.reported)
  await report(msg.reportedOnly)

  const warn = jest.spyOn(logger, "warn")
  let pass = await purgeClosedConversations()
  while (pass.hasMore) pass = await purgeClosedConversations()
  warned = warn.mock.calls.filter(([message]) => String(message).startsWith("DM purge"))
  warn.mockRestore()
})

describe("the DM purge", () => {
  it("deletes the messages of a conversation closed more than 180 days ago, both sides', text and photos", async () => {
    expect(await left([msg.plain, msg.reply, msg.ownPhoto, msg.sealedPhoto, msg.outsidePhoto])).toEqual([])
  })

  it("keeps the messages of a conversation closed 179 days ago", async () => {
    expect(await left([msg.inside])).toEqual([msg.inside])
  })

  it("never touches an open conversation, however old", async () => {
    expect(await left([msg.open])).toEqual([msg.open])
  })

  it("holds a message under a pending report, and one upheld within 180 days", async () => {
    expect((await left([msg.pending, msg.upheldRecently, msg.reportedOnly])).sort()).toEqual([msg.pending, msg.upheldRecently, msg.reportedOnly].sort())
  })

  it("takes a message whose report was upheld more than 180 days ago, or dismissed, and ignores a room report", async () => {
    expect(await left([msg.upheldLongAgo, msg.dismissed, msg.groupReported])).toEqual([])
  })

  it("keeps the conversation rows", async () => {
    expect(await db.private_conversations.count({ where: { id: { in: [conv.past, conv.reported] } } })).toBe(2)
  })

  it("deletes the author's own photos from storage, and nothing for a URL that is not theirs", () => {
    const keys = mockDeleteFile.mock.calls.map(([key]) => key)
    expect(keys).toEqual(expect.arrayContaining([ownPhoto, sealedPhoto]))
    expect(keys.filter((k) => String(k).includes("images.example.com") || String(k).includes("chat/x/"))).toEqual([])
  })

  it("says so in one warning, by row id and class, never the URL", () => {
    expect(warned).toHaveLength(1)
    const [, detail] = warned[0] as [string, { count: number; byClass: Record<string, number>; rows: { id: string }[] }]
    expect(detail.count).toBeGreaterThanOrEqual(1)
    expect(detail.rows.map((r) => r.id)).toContain(msg.outsidePhoto)
    expect(JSON.stringify(warned)).not.toContain("images.example.com")
  })

  it("leaves the survivor's inbox loading, with no row, no preview and no unread count for the purged conversation", async () => {
    const { email } = await db.user.findUniqueOrThrow({ where: { id: survivor }, select: { email: true } })
    const res = await conversations.GET(
      new NextRequest("http://localhost/api/mobile/conversations", { headers: { authorization: `Bearer ${signAccessToken(survivor, email)}` } })
    )
    expect(res.status).toBe(200)
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain(conv.past)
    expect(text).not.toContain("hello")
    expect((await inboxCountsFor([survivor])).get(survivor)).toEqual(expect.objectContaining({ threads: 0 }))
  })
})
