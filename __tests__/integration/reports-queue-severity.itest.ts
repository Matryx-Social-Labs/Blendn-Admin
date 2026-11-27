/**
 * The staff reports queue against the real database (SCRUM-1176): a message
 * report shows the words kept when it was filed, also once the message row is
 * gone, and the queue is taken S1 first, oldest first inside each, by the
 * query itself, so a page of the oldest reports cannot push a newer threat out.
 */
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: Date.now(), ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { randomUUID } from "crypto"
import { getReportQueue } from "@/app/dashboard/moderation/reports/actions"
import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"

const HOUR = 60 * 60 * 1000
const users: string[] = []
const events: string[] = []
let reporter = ""
let reported = ""
let eventId = ""

beforeAll(async () => {
  const admin = await makeUser("rq_admin", "app_admin")
  reporter = await makeUser("rq_reporter")
  reported = await makeUser("rq_reported")
  users.push(admin, reporter, reported)
  eventId = await makeEvent(reporter)
  events.push(eventId)
  session = { user: { id: admin, role: "app_admin" } }
})

afterAll(async () => {
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.event_reports.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

/** A pending report on a room message: by default one whose row no longer exists. */
const report = (reason: string, hoursAgo: number, more: { excerpt?: string; message_id?: string; id?: string; status?: "pending" | "resolved" } = {}) =>
  db.message_reports.create({
    data: { reporter_id: reporter, message_id: randomUUID(), message_type: "group", reason, created_at: new Date(Date.now() - hoursAgo * HOUR), ...more },
  })

it("shows the words kept at report time once the reported message is gone", async () => {
  const r = await report("harassment", 1, { excerpt: "come outside, alone" })

  const row = (await getReportQueue()).rows.find((x) => x.id === r.id)

  expect(row?.excerpt).toBe("come outside, alone")
  expect(row?.gone).toBe(true)
})

it("shows the words as reported, not the message as it reads now", async () => {
  const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room" } })
  const message = await db.chat_messages.create({ data: { chat_group_id: room.id, user_id: reported, content: "sorry, wrong chat" } })
  const r = await report("threat", 1, { excerpt: "I know where you live", message_id: message.id })

  const row = (await getReportQueue()).rows.find((x) => x.id === r.id)

  expect(row?.excerpt).toBe("I know where you live")
  expect(row?.gone).toBe(false)
})

it("puts a threat before harassment before spam across the three tables, whatever their age", async () => {
  const spam = await db.event_reports.create({ data: { event_id: eventId, user_id: reporter, reason: "spam", created_at: new Date(Date.now() - 30 * HOUR) } })
  const harassment = await report("harassment", 20)
  const threat = await db.user_reports.create({ data: { reporter_id: reporter, reported_id: reported, reason: " Threat\n", created_at: new Date(Date.now() - 10 * HOUR) } })

  const mine = new Set([spam.id, harassment.id, threat.id])
  const order = (await getReportQueue()).rows.filter((x) => mine.has(x.id)).map((x) => x.id)

  expect(order).toEqual([threat.id, harassment.id, spam.id])
})

it("takes the older of two reports of one severity first, within the hour", async () => {
  // Ids that sort against their age, so only the filing time can order them.
  const older = await report("spam", 0.5, { id: `ffffffff-${randomUUID().slice(9)}` })
  const newer = await report("spam", 0.1, { id: `00000000-${randomUUID().slice(9)}` })

  const order = (await getReportQueue()).rows.filter((x) => x.id === older.id || x.id === newer.id).map((x) => x.id)

  expect(order).toEqual([older.id, newer.id])
})

it("lists a report on its own status tab only", async () => {
  const done = await report("threat", 1, { status: "resolved" })

  expect((await getReportQueue()).rows.some((x) => x.id === done.id)).toBe(false)
  expect((await getReportQueue("resolved")).rows.some((x) => x.id === done.id)).toBe(true)
})

it("keeps newer threats and harassment on a page full of older spam, and the oldest spam with them", async () => {
  const spam = Array.from({ length: 100 }, (_, i) => ({
    id: randomUUID(),
    reporter_id: reporter,
    message_id: randomUUID(),
    message_type: "group",
    reason: "spam",
    created_at: new Date(Date.now() - (200 + i) * HOUR),
  }))
  await db.message_reports.createMany({ data: spam })
  const threat = await report("threat\t", 0)
  const harassment = await report("harassment", 0)

  const { rows, truncated } = await getReportQueue()
  const ids = new Set(rows.map((x) => x.id))

  expect(ids.has(threat.id)).toBe(true)
  expect(ids.has(harassment.id)).toBe(true)
  expect(ids.has(spam[99].id)).toBe(true)
  expect(truncated).toBe(true)
})
