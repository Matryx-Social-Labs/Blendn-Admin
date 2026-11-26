process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"

import { runStaffAlertSweep } from "@/lib/staff-alert"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * The staff alert's counts against real Postgres (SCRUM-1161): the window, the
 * pending filter, and the severe-flag rule, which reads JSON keys in raw SQL and
 * must survive the sentiment sweeper's array-shaped `categories`.
 *
 * Every row is written at a timestamp no other suite uses, so the counts are
 * this file's alone.
 */

const T = new Date("2031-03-03T03:03:00Z")
const sec = (s: number) => new Date(T.getTime() + s * 1000)

const users: string[] = []
const events: string[] = []
let fetchMock: jest.Mock

beforeAll(() => {
  process.env.STAFF_ALERT_SLACK_WEBHOOK_URL = "http://127.0.0.1:9/staff-alert-itest"
  delete process.env.REDIS_URL
  fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "ok" })
  global.fetch = fetchMock as unknown as typeof fetch
})

afterAll(async () => {
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.chat_messages.deleteMany({ where: { user_id: { in: users } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
}, 60_000)

it("announces one new pending report and the severe flags, once, with nothing about the people", async () => {
  const reporter = await makeUser(testId("sa_reporter"))
  const reported = await makeUser(testId("sa_reported"))
  const host = await makeUser(testId("sa_host"), "organizer")
  users.push(reporter, reported, host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })

  await db.user_reports.create({ data: { reporter_id: reporter, reported_id: reported, reason: "threat", created_at: sec(10) } })
  // Already decided: not new work.
  await db.user_reports.create({ data: { reporter_id: reporter, reported_id: reported, reason: "x", status: "resolved", created_at: sec(11) } })

  const flag = async (categories: object, confidence: number, status: "pending" | "approved" = "pending") => {
    const message = await db.chat_messages.create({ data: { chat_group_id: group.id, user_id: reported, content: "x" } })
    await db.moderation_flags.create({
      data: { message_id: message.id, chat_group_id: group.id, user_id: reported, source: "auto_text", categories, confidence, status, created_at: sec(12) },
    })
  }
  await flag({ "self-harm/intent": 0.5 }, 0.5) // severe by category
  await flag({ spam: 0.95 }, 0.95) // severe by confidence
  await flag({ sexual: 0.5 }, 0.5) // not severe
  await flag(["safety_conduct"], 0.5) // the sentiment sweeper's shape: an array, never an error
  await flag({ violence: 0.99 }, 0.99, "approved") // decided

  // First run: window opens one interval before "boot" (T + 60 s) and trails by the grace.
  await runStaffAlertSweep(sec(60))
  await runStaffAlertSweep(sec(120))

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const text = JSON.parse(fetchMock.mock.calls[0][1].body).text as string
  expect(text).toContain("1 new report")
  expect(text).toContain("2 severe flags")
  for (const id of [reporter, reported, host, eventId, group.id]) expect(text).not.toContain(id)
})
