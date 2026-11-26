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
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.event_reports.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
}, 60_000)

it("announces the new pending reports of all three kinds and the severe flags, once, with nothing about the people", async () => {
  const reporter = await makeUser(testId("sa_reporter"))
  const reported = await makeUser(testId("sa_reported"))
  const host = await makeUser(testId("sa_host"), "organizer")
  users.push(reporter, reported, host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })

  await db.user_reports.create({ data: { reporter_id: reporter, reported_id: reported, reason: "threat", created_at: sec(10) } })
  await db.message_reports.create({ data: { reporter_id: reporter, message_id: group.id, message_type: "group", reason: "x", created_at: sec(10) } })
  await db.event_reports.create({ data: { event_id: eventId, user_id: reporter, reason: "x", created_at: sec(10) } })
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
  await flag({ "violence/graphic": 0.5 }, 0.5) // severe by category
  await flag({ "sexual/minors": 0.3 }, 0.3) // severe by category
  await flag({ "harassment/threatening": 0.5 }, 0.5) // severe by category
  await flag({ sexual: 0.5 }, 0.5) // not severe
  await flag({ harassment: 0.6 }, 0.6) // not severe: the prefix is harassment/threatening
  await flag(["safety_conduct"], 0.5) // the sentiment sweeper's shape: an array, never an error
  await flag({ violence: 0.99 }, 0.99, "approved") // decided

  // First run: window opens one interval before "boot" (T + 60 s) and trails by the grace.
  await runStaffAlertSweep(sec(60))
  await runStaffAlertSweep(sec(120))

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const text = JSON.parse(fetchMock.mock.calls[0][1].body).text as string
  expect(text).toContain("3 new reports")
  expect(text).toContain("5 severe flags")
  for (const id of [reporter, reported, host, eventId, group.id]) expect(text).not.toContain(id)
})

/**
 * A swear word the keyword list hides (`{"profanity": 0.9}`, one word) is a
 * pending flag at exactly 0.9. It goes to the queue and is not a severe flag:
 * only a flag whose sole key is `profanity` loses the confidence arm. Each test
 * runs its own one-minute window after the one before.
 */
describe("profanity-only flags", () => {
  let reporter: string
  let reported: string
  let groupId: string
  let sweepAt = 120

  beforeAll(async () => {
    reporter = await makeUser(testId("sa_p_reporter"))
    reported = await makeUser(testId("sa_p_reported"))
    const host = await makeUser(testId("sa_p_host"), "organizer")
    users.push(reporter, reported, host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })).id
  })

  /** The next window: rows written now land in it, and `sweep` closes it. */
  function nextWindow() {
    sweepAt += 60
    const rowAt = sec(sweepAt - 50)
    const flag = async (categories: object, confidence: number, source: "auto_keyword" | "auto_text" = "auto_keyword") => {
      const message = await db.chat_messages.create({ data: { chat_group_id: groupId, user_id: reported, content: "x" } })
      await db.moderation_flags.create({
        data: { message_id: message.id, chat_group_id: groupId, user_id: reported, source, categories, confidence, auto_action: "hidden", created_at: rowAt },
      })
    }
    const report = () => db.user_reports.create({ data: { reporter_id: reporter, reported_id: reported, reason: "x", created_at: rowAt } })
    const sweep = async (): Promise<string | null> => {
      fetchMock.mockClear()
      await runStaffAlertSweep(sec(sweepAt))
      return fetchMock.mock.calls.length ? (JSON.parse(fetchMock.mock.calls[0][1].body).text as string) : null
    }
    return { flag, report, sweep }
  }

  it("sends nothing for swear-word hides alone, one word or two", async () => {
    const w = nextWindow()
    await w.flag({ profanity: 0.9 }, 0.9)
    await w.flag({ profanity: 0.95 }, 0.95)
    expect(await w.sweep()).toBeNull()
  })

  it("alerts on profanity beside another category on one flag", async () => {
    const w = nextWindow()
    await w.flag({ profanity: 0.9, harassment: 0.9 }, 0.9)
    expect(await w.sweep()).toContain("1 severe flag;")
  })

  it("alerts on a slur hide", async () => {
    const w = nextWindow()
    await w.flag({ slur: 0.9 }, 0.9)
    expect(await w.sweep()).toContain("1 severe flag;")
  })

  it("alerts on a line the model judged abusive", async () => {
    const w = nextWindow()
    await w.flag({ harassment: 0.95 }, 0.95, "auto_text")
    expect(await w.sweep()).toContain("1 severe flag;")
  })

  it("alerts on the sentiment sweeper's array-shaped flag at 0.95, and never raises on it", async () => {
    const w = nextWindow()
    await w.flag(["safety_conduct"], 0.95, "auto_text")
    expect(await w.sweep()).toContain("1 severe flag;")
  })

  it("alerts on a report with no flag", async () => {
    const w = nextWindow()
    await w.report()
    expect(await w.sweep()).toContain("1 new report;")
  })

  it("counts only the severe flags when a swear-word hide shares the window", async () => {
    const w = nextWindow()
    await w.flag({ profanity: 0.9 }, 0.9)
    await w.flag({ violence: 0.95 }, 0.95, "auto_text")
    expect(await w.sweep()).toContain("1 severe flag;")
  })

  it("counts the report only when a swear-word hide sits beside it", async () => {
    const w = nextWindow()
    await w.flag({ profanity: 0.9 }, 0.9)
    await w.report()
    const text = await w.sweep()
    expect(text).toContain("1 new report;")
    expect(text).not.toContain("severe")
  })
})

/**
 * A swear-word hide the model could not judge (`{"profanity", "unjudged"}`,
 * written by `recordHide`) is not a severe flag. It is said on its own line,
 * at most once per `UNJUDGED_REPEAT_MS`, and the count then is every such
 * pending flag since the line was last sent. A slur, a model flag and a report
 * still alert every minute.
 */
describe("hides the model could not judge", () => {
  let reporter: string
  let reported: string
  let groupId: string
  let sweepAt = 1_000
  const UNJUDGED = { profanity: 0.9, unjudged: 0.9 }

  beforeAll(async () => {
    reporter = await makeUser(testId("sa_u_reporter"))
    reported = await makeUser(testId("sa_u_reported"))
    const host = await makeUser(testId("sa_u_host"), "organizer")
    users.push(reporter, reported, host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })).id
  })

  /** The window `seconds` on from the last: rows written now land in it, and `sweep` closes it. */
  function windowAfter(seconds: number) {
    sweepAt += seconds
    const rowAt = sec(sweepAt - 50)
    const flag = async (categories: object, confidence: number, source: "auto_keyword" | "auto_text" = "auto_keyword") => {
      const message = await db.chat_messages.create({ data: { chat_group_id: groupId, user_id: reported, content: "x" } })
      await db.moderation_flags.create({
        data: { message_id: message.id, chat_group_id: groupId, user_id: reported, source, categories, confidence, auto_action: "hidden", created_at: rowAt },
      })
    }
    const report = () => db.user_reports.create({ data: { reporter_id: reporter, reported_id: reported, reason: "x", created_at: rowAt } })
    const sweep = async (): Promise<string | null> => {
      fetchMock.mockClear()
      await runStaffAlertSweep(sec(sweepAt))
      return fetchMock.mock.calls.length ? (JSON.parse(fetchMock.mock.calls[0][1].body).text as string) : null
    }
    return { flag, report, sweep }
  }

  it("says an unjudged hide on its own line, not as a severe flag", async () => {
    const w = windowAfter(60)
    await w.flag(UNJUDGED, 0.9)
    const text = await w.sweep()
    expect(text).toContain("1 hidden line the model could not judge.")
    expect(text).not.toContain("severe")
  })

  it("holds that line for the next minutes, while a slur, a model flag and a report still alert each minute", async () => {
    let w = windowAfter(60)
    await w.flag(UNJUDGED, 0.9)
    await w.flag({ slur: 0.9 }, 0.9)
    let text = await w.sweep()
    expect(text).toContain("1 severe flag;")
    expect(text).not.toContain("could not judge")

    w = windowAfter(60)
    await w.flag(UNJUDGED, 0.95)
    await w.flag({ "harassment/threatening": 0.55 }, 0.55, "auto_text")
    text = await w.sweep()
    expect(text).toContain("1 severe flag;")
    expect(text).not.toContain("could not judge")

    w = windowAfter(60)
    await w.flag(UNJUDGED, 0.9)
    await w.report()
    text = await w.sweep()
    expect(text).toContain("1 new report;")
    expect(text).not.toContain("could not judge")

    w = windowAfter(60)
    await w.flag(UNJUDGED, 0.9)
    expect(await w.sweep()).toBeNull()
  })

  it("after the hold, counts every unjudged hide since the line was last sent, not only this minute's", async () => {
    const w = windowAfter(15 * 60)
    await w.flag(UNJUDGED, 0.9)
    const text = await w.sweep()
    expect(text).toContain("5 hidden lines the model could not judge.")
    expect(text).not.toContain("severe")
  })

  it("repeats the line next minute when the send failed, and holds it only once it went out", async () => {
    let w = windowAfter(15 * 60)
    await w.flag(UNJUDGED, 0.9)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "no" })
    expect(await w.sweep()).toContain("1 hidden line the model could not judge.")

    w = windowAfter(60)
    expect(await w.sweep()).toContain("1 hidden line the model could not judge.")

    w = windowAfter(60)
    await w.flag(UNJUDGED, 0.9)
    expect(await w.sweep()).toBeNull()
  })
})
