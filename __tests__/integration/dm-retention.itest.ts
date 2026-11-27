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
import { DM_BATCH, purgeClosedConversations, type DmPurgePass } from "@/lib/dm-retention"
import { logger } from "@/lib/logger"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const conversations = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const BUCKET = "https://blendn-media-private.fly.storage.tigris.dev"

const users: string[] = []
const events: string[] = []
let author = ""
let survivor = ""
let reporter = ""
const conv: Record<string, string> = {}
const msg: Record<string, string> = {}
let ownPhoto = ""
let heldPhoto = ""
let firstPass: DmPurgePass
const sealedPhoto = `chat/sealed/${randomUUID()}`
let warned: unknown[][] = []

afterAll(async () => {
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.message_requests.deleteMany({ where: { sender_id: { in: users } } })
  await cleanup(users, events)
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
  const others = await Promise.all(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((l) => makeUser(testId(`dmr-other-${l}`))))
  users.push(author, survivor, reporter, ...others)
  ownPhoto = `chat/${author}/1758000000000-${randomUUID().slice(0, 6)}-photo.jpg`
  heldPhoto = `chat/${author}/1758000000000-${randomUUID().slice(0, 6)}-held.jpg`
  await onboard(author, survivor, reporter, ...others)

  // Closed 181 days ago (the author deleted their account): past its time.
  conv.past = await conversation(author, survivor, 181)
  msg.plain = await write(conv.past)
  msg.reply = await write(conv.past, { sender_id: survivor }, survivor)
  msg.ownPhoto = await write(conv.past, { message_text: null, media_url: `${BUCKET}/${ownPhoto}`, media_type: "image" })
  msg.sealedPhoto = await write(conv.past, { message_text: null, media_url: `${BUCKET}/${sealedPhoto}`, media_type: "image" })
  msg.outsidePhoto = await write(conv.past, { message_text: null, media_url: "https://images.example.com/chat/x/photo.jpg", media_type: "image" })
  // Reports on messages in it: pending holds, upheld inside 180 days holds, the rest do not.
  // The request that opened it: its first words are the conversation's too.
  await db.message_requests.create({ data: { sender_id: survivor, recipient_id: author, status: "accepted", message: "hello, it's me", responded_at: ago(400) } })
  // A held message's photo stays in storage with it.
  msg.pending = await write(conv.past, { media_url: `${BUCKET}/${heldPhoto}`, media_type: "image" })
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

  // A person report filed from the conversation ("unmatch and report", no message named): pending holds the whole
  // thread, both sides; one dismissed holds nothing.
  conv.personReported = await conversation(author, others[3], 200)
  msg.personReportedTheirs = await write(conv.personReported)
  msg.personReportedMine = await write(conv.personReported, {}, others[3])
  await db.user_reports.create({ data: { reporter_id: others[3], reported_id: author, reason: "harassment", excerpt: "hello" } })
  conv.personDismissed = await conversation(author, others[4], 200)
  msg.personDismissed = await write(conv.personDismissed)
  await db.user_reports.create({ data: { reporter_id: others[4], reported_id: author, reason: "spam", status: "reviewed", reviewed_at: ago(5) } })
  // Both ways round in the pair (user1 reports user2, user2 reports user1), by ids that sort on either side of the author's.
  const low = await makeUser(testId("dmr-aaa-low"))
  const high = await makeUser(testId("dmr-zzz-high"))
  users.push(low, high)
  for (const [other, tag] of [[low, "low"], [high, "high"]] as const) {
    conv[`person-${tag}`] = await conversation(author, other, 200)
    msg[`person-${tag}`] = await write(conv[`person-${tag}`])
    await db.user_reports.create({ data: { reporter_id: other, reported_id: author, reason: "harassment" } })
  }
  // Its request's words are held with it.
  await db.message_requests.create({ data: { sender_id: low, recipient_id: author, status: "accepted", message: "hello from low", responded_at: ago(400) } })
  // A person report upheld 10 days ago holds; one upheld 181 days ago does not.
  conv.personUpheld = await conversation(author, others[6], 200)
  msg.personUpheld = await write(conv.personUpheld)
  await db.user_reports.create({ data: { reporter_id: others[6], reported_id: author, reason: "harassment", status: "resolved", reviewed_at: ago(10) } })
  conv.personUpheldLongAgo = await conversation(author, others[7], 200)
  msg.personUpheldLongAgo = await write(conv.personUpheldLongAgo)
  await db.user_reports.create({ data: { reporter_id: others[7], reported_id: author, reason: "harassment", status: "resolved", reviewed_at: ago(181) } })
  // A sender reporting their own message holds nothing.
  conv.selfReported = await conversation(author, others[5], 200)
  msg.selfReported = await write(conv.selfReported)
  await db.message_reports.create({ data: { reporter_id: author, message_id: msg.selfReported, message_type: "private", reason: "other" } })

  const warn = jest.spyOn(logger, "warn")
  firstPass = await purgeClosedConversations()
  let pass = firstPass
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

  it("holds both sides of a conversation whose person report from it is pending, and not one that was dismissed", async () => {
    expect((await left([msg.personReportedTheirs, msg.personReportedMine])).sort()).toEqual([msg.personReportedTheirs, msg.personReportedMine].sort())
    expect(await left([msg.personDismissed])).toEqual([])
  })

  it("holds a person report's conversation whichever of the pair filed it, and one upheld within 180 days", async () => {
    expect((await left([msg["person-low"], msg["person-high"], msg.personUpheld])).sort()).toEqual([msg["person-low"], msg["person-high"], msg.personUpheld].sort())
    expect(await left([msg.personUpheldLongAgo])).toEqual([])
  })

  it("blanks the words of the request that opened a purged conversation, and keeps a held one's", async () => {
    const words = await db.message_requests.findMany({ where: { recipient_id: author }, select: { sender_id: true, message: true, status: true } })
    expect(words).toEqual(expect.arrayContaining([
      { sender_id: survivor, message: null, status: "accepted" },
      { sender_id: users.find((u) => u.includes("dmr-aaa-low"))!, message: "hello from low", status: "accepted" },
    ]))
  })

  it("leaves a held message's photo in storage", () => {
    expect(mockDeleteFile.mock.calls.map(([key]) => key)).not.toContain(heldPhoto)
  })

  it("counts what the pass took", () => {
    // At least this suite's own due rows: other suites may leave theirs.
    expect(firstPass.messages).toBeGreaterThanOrEqual(11)
    expect(firstPass.photos).toBeGreaterThanOrEqual(2)
  })

  it("holds nothing for a sender's report of their own message", async () => {
    expect(await left([msg.selfReported])).toEqual([])
  })

  it("keeps a message whose photo could not be deleted from storage, for the next pass", async () => {
    const id = await write(conv.past, { message_text: null, media_url: `${BUCKET}/chat/${author}/1758000000000-${randomUUID().slice(0, 6)}-kept.jpg`, media_type: "image" })
    mockDeleteFile.mockRejectedValueOnce(new Error("storage down"))
    const errors = jest.spyOn(logger, "error").mockImplementation(() => {})
    const pass = await purgeClosedConversations()
    expect(errors.mock.calls.map(([m]) => String(m))).toContain("DM purge: object NOT deleted; its row is kept for the next pass")
    errors.mockRestore()
    expect(pass.kept).toBe(1)
    expect(await left([id])).toEqual([id])
    expect((await purgeClosedConversations()).messages).toBeGreaterThanOrEqual(1)
    expect(await left([id])).toEqual([])
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

describe("the DM purge, its bounds", () => {
  it("takes a conversation closed 1 ms past 180 days and keeps one closed exactly 180 days ago", async () => {
    const now = new Date()
    const [a, b, c] = await Promise.all(["edge-a", "edge-b", "edge-c"].map((l) => makeUser(testId(`dmr-${l}`))))
    users.push(a, b, c)
    const at = (closed: Date) => db.private_conversations.create({ data: { user1_id: [a, b].sort()[0], user2_id: [a, b].sort()[1], closed_at: closed, closed_by: a, closed_reason: "unmatch" }, select: { id: true } })
    const edge = new Date(now.getTime() - 180 * DAY)
    const exactly = (await at(edge)).id
    const past = (await db.private_conversations.create({ data: { user1_id: [a, c].sort()[0], user2_id: [a, c].sort()[1], closed_at: new Date(edge.getTime() - 1), closed_by: a, closed_reason: "unmatch" }, select: { id: true } })).id
    const kept = await write(exactly, {}, a)
    const gone = await write(past, {}, a)
    await purgeClosedConversations(now)
    expect(await left([kept, gone])).toEqual([kept])
  })

  it("waits for the event's insight counts when the conversation was opened at an event", async () => {
    const [a, b] = await Promise.all(["tally-a", "tally-b"].map((l) => makeUser(testId(`dmr-${l}`))))
    users.push(a, b)
    const event = await makeEvent(a)
    events.push(event)
    const id = await conversation(a, b, 200)
    await db.private_conversations.update({ where: { id }, data: { origin_event_id: event } })
    const m = await write(id, {}, a)
    await purgeClosedConversations()
    expect(await left([m])).toEqual([m])
    await db.event_insight_tallies.create({ data: { event_id: event, counts: {} } })
    await purgeClosedConversations()
    expect(await left([m])).toEqual([])
  })

  it("deletes at most a batch a pass, says there is more, and drains on the next", async () => {
    const [a, b] = await Promise.all(["batch-a", "batch-b"].map((l) => makeUser(testId(`dmr-${l}`))))
    users.push(a, b)
    const id = await conversation(a, b, 200)
    await db.private_messages.createMany({ data: Array.from({ length: DM_BATCH + 1 }, () => ({ conversation_id: id, sender_id: a, message_text: "x" })) })
    const warn = jest.spyOn(logger, "warn")
    const first = await purgeClosedConversations()
    const second = await purgeClosedConversations()
    expect(first).toEqual(expect.objectContaining({ messages: DM_BATCH, hasMore: true }))
    // At least the one left over (the edge test's conversation closed exactly 180 days ago is now past it too).
    expect(second.hasMore).toBe(false)
    expect(second.messages).toBeGreaterThanOrEqual(1)
    // Nothing refused, nothing to warn about.
    expect(warn.mock.calls.filter(([m]) => String(m).startsWith("DM purge"))).toEqual([])
    warn.mockRestore()
    expect(await db.private_messages.count({ where: { conversation_id: id } })).toBe(0)
  })
})
