/*
 * The host is mailed when a critical live alert opens (SCRUM-1286). The issue sweep (`lib/event-issues.ts`) records
 * alerts every minute for events nobody is watching; a host who is not on the dashboard learns of an over-capacity
 * room or a safety report only from this mail.
 *
 * Every way it can be wrong is quiet: a mail every minute while the condition lasts, a mail for a warning, a flapping
 * room mailing every other minute, the morning mail's unsubscribe stopping a safety alert, or a slow or failing Resend
 * holding up or breaking the sweep, which then records nothing for anybody.
 */
const issues: Issue[] = []
const mockDb = {
  events: { findFirst: jest.fn() },
  event_issues: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  organisation_members: { findMany: jest.fn() },
  email_suppressions: { findUnique: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))
const mockRead = jest.fn()
jest.mock("@/lib/live-snapshot", () => ({ readLiveSnapshot: (...a: unknown[]) => mockRead(...a) }))

import * as email from "@/lib/email"
import { recordIssuesFor } from "@/lib/event-issues"
import { deriveAlerts, type LiveFigures } from "@/lib/live-metrics"
import { logger } from "@/lib/logger"

type Issue = { id: string; event_id: string; kind: string; severity: string; opened_at: Date; resolved_at: Date | null; mailed_at: Date | null }
type Sent = { to: string[]; subject: string; text: string; html: string; headers?: Record<string, string>; tags: { name: string; value: string }[] }

const EVENT = "e0000000-0000-4000-8000-000000000009"
const ORG = "0a000000-0000-4000-8000-000000000009"
const MIN = 60_000
/** 23:10 in Bengaluru, 12:40 in Toronto. */
const NOW = new Date("2026-11-28T17:40:00Z")
const START = new Date(NOW.getTime() - 2 * 60 * MIN)
const END = new Date(NOW.getTime() + 4 * 60 * MIN)
const OWNER = { id: "u-owner", email: "owner@blendn.app" }
const OWNER2 = { id: "u-owner2", email: "Second.Owner@Blendn.app " }

/** A room of 100 with 112 guests and 3 staff inside: over capacity, nothing else. */
const OVER: LiveFigures = {
  eventId: EVENT,
  at: NOW.toISOString(),
  inside: 115,
  guestsInside: 112,
  staffInside: 3,
  checkedInTotal: 115,
  checkedOutTotal: 0,
  unconfirmed: 0,
  capacity: 100,
  fillPct: 112,
  overCapacity: true,
  checkInRate10m: 0,
  medianRate10m: 0,
  // A talking room: "Room has gone quiet" (a warning) stays out of the way.
  messagesPerMinute: 3,
  activeChatters30m: 12,
  openFlags: 0,
  sentiment: { positive: 0, neutral: 0, negative: 0 },
  categories: [],
}
const UNDER: LiveFigures = { ...OVER, inside: 50, guestsInside: 47, checkedInTotal: 50, fillPct: 47, overCapacity: false }
const NEARLY: LiveFigures = { ...OVER, inside: 95, guestsInside: 92, checkedInTotal: 95, fillPct: 92, overCapacity: false }
const SAFETY: LiveFigures = { ...UNDER, categories: [{ category: "safety_conduct", count: 2 }] }
const alertOf = (figures: LiveFigures, kind: string) => deriveAlerts(figures, { scheduledEnd: END, scheduledStart: START, now: NOW }).find((a) => a.kind === kind)!

let sent: Sent[] = []
let fetchImpl: (body: Sent) => Promise<Response> = async () => new Response(JSON.stringify({ id: "m" }), { status: 200 })
const suppressions = new Map<string, string>()
let event: { title: string; timezone: string; organizer_org_id: string | null } | null
type Where = { id: string | { in: string[] }; mailed_at?: Date }
const matches = (i: Issue, where: Where) =>
  (typeof where.id === "string" ? i.id === where.id : where.id.in.includes(i.id)) &&
  (where.mailed_at === undefined || i.mailed_at?.getTime() === where.mailed_at.getTime())

function world(o: { figures?: LiveFigures; members?: { id: string; email: string }[] } = {}) {
  issues.length = 0
  suppressions.clear()
  event = { title: "Friday at Toit", timezone: "Asia/Kolkata", organizer_org_id: ORG }
  room(o.figures ?? OVER)
  mockDb.events.findFirst.mockImplementation(async () => event)
  mockDb.organisation_members.findMany.mockResolvedValue((o.members ?? [OWNER, OWNER2]).map((user) => ({ user })))
  mockDb.email_suppressions.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
    suppressions.has(where.email) ? { reason: suppressions.get(where.email) } : null
  )
  // event_issues as the database keeps it, for one event and occurrence.
  mockDb.event_issues.findMany.mockImplementation(async () => issues.filter((i) => !i.resolved_at).map(({ id, kind }) => ({ id, kind })))
  mockDb.event_issues.create.mockImplementation(async ({ data }: { data: Omit<Issue, "id" | "resolved_at" | "mailed_at"> }) => {
    const row = { ...data, id: `i${issues.length + 1}`, resolved_at: null, mailed_at: null }
    issues.push(row)
    return { id: row.id }
  })
  mockDb.event_issues.update.mockResolvedValue({})
  // As Postgres applies them: the resolve (id in), the claim (id) and the give-back (id and this claim's mailed_at).
  mockDb.event_issues.updateMany.mockImplementation(async ({ where, data }: { where: Where; data: Partial<Issue> }) => {
    const hit = issues.filter((i) => matches(i, where))
    for (const i of hit) Object.assign(i, data)
    return { count: hit.length }
  })
  mockDb.event_issues.count.mockImplementation(
    async ({ where }: { where: { event_id: string; kind: string; mailed_at: { gt: Date } } }) =>
      issues.filter((i) => i.event_id === where.event_id && i.kind === where.kind && !!i.mailed_at && i.mailed_at > where.mailed_at.gt).length
  )
}
const room = (figures: LiveFigures) =>
  mockRead.mockResolvedValue({ figures, event: { start_time: START, end_time: END }, occurrenceId: null, snapshot: {} })

/** The mail is fire and forget: let its promise chain run out before reading what was sent. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}
const sweep = async (at: Date, figures?: LiveFigures) => {
  if (figures) room(figures)
  const r = await recordIssuesFor(EVENT, at)
  await settle()
  return r
}

beforeAll(() => {
  process.env.RESEND_API_KEY = "re_test"
  process.env.EMAIL_FROM = "Blend'n <hello@blendn.app>"
  process.env.NEXTAUTH_SECRET = "x".repeat(40)
  process.env.DASHBOARD_HOST = "dashboard.blendn.app"
  global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Sent
    const res = await fetchImpl(body)
    if (res.ok) sent.push(body)
    return res
  }) as unknown as typeof fetch
})

beforeEach(() => {
  jest.clearAllMocks()
  jest.restoreAllMocks()
  sent = []
  fetchImpl = async () => new Response(JSON.stringify({ id: "m" }), { status: 200 })
  delete process.env.EMAIL_REPLY_TO
  world()
})

describe("which openings mail", () => {
  it("a new over-capacity issue mails each owner and admin once: the alert's own words, its time on the event's clock, the Live tab", async () => {
    const r = await sweep(NOW)
    expect(r.opened).toBe(1)

    expect(sent.map((m) => m.to[0]).sort()).toEqual(["owner@blendn.app", "second.owner@blendn.app"])
    const [mail] = sent
    const alert = alertOf(OVER, "over_capacity")
    expect(mail.subject).toBe("Friday at Toit: Over stated capacity")
    // The dashboard's words, from deriveAlerts, not a second version.
    expect(mail.text).toContain(alert.body)
    expect(mail.text).toContain("112 guests against capacity 100")
    expect(mail.text).toContain("23:10")
    expect(mail.text).toContain(`https://dashboard.blendn.app/dashboard/events/${EVENT}?tab=live`)
    expect(mail.text).not.toMatch(/IST|Asia\/Kolkata|GMT|UTC|\+05/)
    expect(mail.html).toContain("Open the Live tab")
    expect(mail.html).toContain(`/dashboard/events/${EVENT}?tab=live`)
    expect(mail.html).toContain("112 guests against capacity 100")
    expect(mail.html).toContain("Friday at Toit, opened at 23:10.")
    expect(mail.tags).toEqual([{ name: "kind", value: "live_alert" }])
    // The opening is claimed: the window counts from this mail.
    expect(issues[0].mailed_at).toEqual(NOW)
  })

  it("two critical alerts opening in one pass each mail once", async () => {
    await sweep(NOW, { ...OVER, categories: SAFETY.categories })
    expect(sent.map((m) => m.subject).sort()).toEqual([
      "Friday at Toit: Over stated capacity",
      "Friday at Toit: Over stated capacity",
      "Friday at Toit: Safety",
      "Friday at Toit: Safety",
    ])
  })

  it("a safety issue mails, with the safety alert's own body", async () => {
    await sweep(NOW, SAFETY)
    expect(sent).toHaveLength(2)
    expect(sent[0].subject).toBe("Friday at Toit: Safety")
    expect(sent[0].text).toContain(alertOf(SAFETY, "safety").body)
  })

  it("an issue still open is bumped on the next pass and mails nobody again", async () => {
    await sweep(NOW)
    expect(sent).toHaveLength(2)
    await sweep(new Date(NOW.getTime() + MIN))
    await sweep(new Date(NOW.getTime() + 2 * MIN))
    expect(mockDb.event_issues.update).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(2)
  })

  it("a warning opens an issue and mails nobody", async () => {
    const r = await sweep(NOW, NEARLY)
    expect(r.opened).toBe(1)
    expect(issues[0]).toMatchObject({ kind: "approaching_capacity", severity: "warning" })
    expect(sent).toHaveLength(0)
    expect(mockDb.organisation_members.findMany).not.toHaveBeenCalled()
  })

  it("a flapping room (over, under, over) opens a new issue each time and mails once in 30 minutes per event and kind", async () => {
    await sweep(NOW, OVER)
    await sweep(new Date(NOW.getTime() + 1 * MIN), UNDER)
    await sweep(new Date(NOW.getTime() + 2 * MIN), OVER)
    await sweep(new Date(NOW.getTime() + 3 * MIN), UNDER)
    await sweep(new Date(NOW.getTime() + 29 * MIN), OVER)
    expect(issues.filter((i) => i.kind === "over_capacity")).toHaveLength(3)
    expect(sent).toHaveLength(2)
    // Another kind is its own alert.
    await sweep(new Date(NOW.getTime() + 30 * MIN), { ...SAFETY, ...OVER, categories: SAFETY.categories })
    expect(sent.map((m) => m.subject)).toEqual([
      "Friday at Toit: Over stated capacity",
      "Friday at Toit: Over stated capacity",
      "Friday at Toit: Safety",
      "Friday at Toit: Safety",
    ])
  })

  it("an opening 30 minutes or more after the last mail mails again, even inside a chain of openings", async () => {
    await sweep(NOW, OVER)
    await sweep(new Date(NOW.getTime() + 1 * MIN), UNDER)
    await sweep(new Date(NOW.getTime() + 20 * MIN), OVER)
    await sweep(new Date(NOW.getTime() + 21 * MIN), UNDER)
    expect(sent).toHaveLength(2)
    // 30 minutes to the minute after the mail at NOW (the 20-minute opening was not mailed, so it does not count).
    await sweep(new Date(NOW.getTime() + 30 * MIN), OVER)
    expect(sent).toHaveLength(4)
    expect(issues.filter((i) => i.mailed_at).map((i) => i.opened_at)).toEqual([NOW, new Date(NOW.getTime() + 30 * MIN)])
  })

  it("an opening nobody was mailed about gives its claim back, and the next opening is mailed", async () => {
    fetchImpl = async () => new Response("no", { status: 422 })
    jest.spyOn(logger, "warn").mockImplementation(() => {})
    jest.spyOn(logger, "error").mockImplementation(() => {})
    await sweep(NOW, OVER)
    expect(issues[0].mailed_at).toBeNull()
    await sweep(new Date(NOW.getTime() + 1 * MIN), UNDER)
    fetchImpl = async () => new Response(JSON.stringify({ id: "m" }), { status: 200 })
    await sweep(new Date(NOW.getTime() + 2 * MIN), OVER)
    expect(sent).toHaveLength(2)
  })

  it("an event with no organization, or that is not a real event (a venue day), mails nobody", async () => {
    event = { title: "Friday at Toit", timezone: "Asia/Kolkata", organizer_org_id: null }
    await sweep(NOW)
    expect(sent).toHaveLength(0)
    expect(mockDb.organisation_members.findMany).not.toHaveBeenCalled()
    // A venue day (or a deleted event) is not found by the mail's read.
    expect(mockDb.events.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: EVENT, kind: "event", deleted_at: null }) })
    )
  })

  it("an event the mail's read does not find (a venue day, a deleted event) mails nobody and is not an error", async () => {
    event = null
    const error = jest.spyOn(logger, "error")
    const info = jest.spyOn(logger, "info").mockImplementation(() => {})
    const r = await sweep(NOW)
    expect(r.opened).toBe(1)
    expect(sent).toHaveLength(0)
    expect(error).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith("Live alert not mailed: no organization", { eventId: EVENT, kind: "over_capacity" })
  })

  it("the time is told on the event's clock: Toronto's night says 12:40", async () => {
    event = { title: "Toronto Social", timezone: "America/Toronto", organizer_org_id: ORG }
    await sweep(NOW)
    expect(sent[0].text).toContain("12:40")
    expect(sent[0].text).not.toMatch(/EST|EDT|Toronto Social.*Toronto\b/)
  })
})

describe("who gets it", () => {
  it("recipients are the org's owners and admins by membership, not deleted or suspended", async () => {
    await sweep(NOW)
    expect(mockDb.organisation_members.findMany).toHaveBeenCalledWith({
      where: { org_id: ORG, role: { in: ["owner", "admin"] }, user: { deletedAt: null, suspended_at: null } },
      select: { user: { select: { id: true, email: true } } },
    })
  })

  it("an organization with no owner or admin left: the issue is recorded, nobody mailed, and it says so", async () => {
    world({ members: [] })
    const error = jest.spyOn(logger, "error")
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => {})
    const r = await sweep(NOW)
    expect(r.opened).toBe(1)
    expect(sent).toHaveLength(0)
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("Live alert mail reached nobody", expect.objectContaining({ eventId: EVENT, kind: "over_capacity", recipients: 0 }))
    expect(issues[0].mailed_at).toBeNull()
  })

  it("a bounced owner is skipped and the other owner still mailed", async () => {
    suppressions.set("owner@blendn.app", "bounce")
    await sweep(NOW)
    expect(sent.map((m) => m.to[0])).toEqual(["second.owner@blendn.app"])
  })

  it("an owner who unsubscribed from the morning mail still gets a live alert: transactional, no List-Unsubscribe", async () => {
    suppressions.set("owner@blendn.app", "unsubscribe")
    await sweep(NOW)
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["owner@blendn.app", "second.owner@blendn.app"])
    for (const m of sent) expect(Object.keys(m.headers ?? {})).not.toContain("List-Unsubscribe")
    expect(sent[0].text).not.toMatch(/unsubscribe/i)
    expect(sent[0].html).not.toMatch(/unsubscribe/i)
  })

  it("the event title is escaped in the HTML", async () => {
    event = { title: "Tom & Jerry <b>Night</b>", timezone: "Asia/Kolkata", organizer_org_id: ORG }
    await sweep(NOW)
    expect(sent[0].html).toContain("Tom &amp; Jerry &lt;b&gt;Night&lt;/b&gt;")
    expect(sent[0].html).not.toContain("<b>Night</b>")
  })
})

describe("the sweep is never slowed or broken by the mail", () => {
  it("a sendEmail that throws: the issue is recorded, the sweep resolves, the failure is logged with event and kind", async () => {
    jest.spyOn(email, "sendEmail").mockRejectedValue(new Error("boom"))
    const error = jest.spyOn(logger, "error").mockImplementation(() => {})
    const r = await sweep(NOW)
    expect(r).toEqual({ opened: 1, stillOpen: 0, resolved: 0 })
    expect(issues).toHaveLength(1)
    expect(error).toHaveBeenCalledWith("Live alert mail failed", expect.objectContaining({ eventId: EVENT, kind: "over_capacity" }))
  })

  it("a Resend that never answers: recordIssuesFor resolves without waiting for it", async () => {
    fetchImpl = () => new Promise(() => {})
    const r = await recordIssuesFor(EVENT, NOW)
    expect(r.opened).toBe(1)
    expect(issues).toHaveLength(1)
    // And the mail was really on its way: the first owner's send hangs (sends are one at a time), not skipped.
    await settle()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it("a failing recipient lookup: the issue is recorded and the failure logged with event and kind", async () => {
    mockDb.organisation_members.findMany.mockRejectedValue(new Error("db down"))
    const error = jest.spyOn(logger, "error").mockImplementation(() => {})
    const r = await sweep(NOW)
    expect(r.opened).toBe(1)
    expect(issues).toHaveLength(1)
    expect(error).toHaveBeenCalledWith("Live alert mail failed", expect.objectContaining({ eventId: EVENT, kind: "over_capacity" }))
  })

  it("a failing event read (the organization cannot be found): the issue is recorded and the failure logged", async () => {
    mockDb.events.findFirst.mockRejectedValue(new Error("db down"))
    const error = jest.spyOn(logger, "error").mockImplementation(() => {})
    const r = await sweep(NOW)
    expect(r.opened).toBe(1)
    expect(issues).toHaveLength(1)
    expect(error).toHaveBeenCalledWith("Live alert mail failed", expect.objectContaining({ eventId: EVENT, kind: "over_capacity" }))
  })

  it("a provider refusal is logged with event and kind, and the sweep goes on", async () => {
    fetchImpl = async () => new Response("no", { status: 422 })
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => {})
    jest.spyOn(logger, "error").mockImplementation(() => {})
    const r = await sweep(NOW)
    expect(r.opened).toBe(1)
    expect(warn).toHaveBeenCalledWith("Live alert mail reached nobody", expect.objectContaining({ eventId: EVENT, kind: "over_capacity", failed: 2 }))
  })
})
