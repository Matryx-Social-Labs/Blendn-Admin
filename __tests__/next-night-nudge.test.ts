/*
 * The "list your next" nudge (SCRUM-1284, launch gate 14): one mail to an organization's owners and admins at 10:00 on
 * the event's clock a week after its latest night, when nothing is coming up, at most once in 30 days.
 *
 * Every way it can be wrong is silent: sent at 02:00, sent three weeks late on deploy day, sent every pass, sent to a
 * host who already listed the next night, a figure under the floor printed, or an owner who unsubscribed mailed anyway.
 * The database half (which nights, which events count as coming up) is in integration/next-night-nudge.itest.ts.
 */
const mockDb = {
  events: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  organisations: { updateMany: jest.fn() },
  organisation_members: { findMany: jest.fn() },
  event_check_ins: { findMany: jest.fn() },
  email_suppressions: { findUnique: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

import { sendNextNightNudges } from "@/lib/next-night-nudge"

const ORG = "0a000000-0000-4000-8000-000000000004"
const DAY = 86_400_000
/** Ends 02:00 IST Fri 2026-11-20 (a night that runs past midnight): nudged at 10:00 IST Fri 2026-11-27 (04:30Z). */
const NIGHT = {
  id: "e0000000-0000-4000-8000-000000000004",
  title: "Friday at Toit",
  end_time: new Date("2026-11-19T20:30:00Z"),
  timezone: "Asia/Kolkata",
  organizer_org_id: ORG,
  organizer_org: { next_event_nudged_at: null as Date | null },
}
const DAY7_TEN = new Date("2026-11-27T04:30:00Z")
const OWNER = { id: "u-owner", email: "owner@blendn.app" }
const ADMIN = { id: "u-admin", email: "Admin@Blendn.app " }

type Sent = { to: string[]; subject: string; text: string; html: string; headers: Record<string, string>; tags: { name: string; value: string }[] }
let sent: Sent[] = []
let fetchStatus: (to: string) => number = () => 200
let duringSend: () => void = () => {}

/** `organisations.next_event_nudged_at` per organization, as the database keeps it: the conditional update is the only writer. */
const nudged = new Map<string, Date | null>()
const nudgedAt = () => nudged.get(ORG) ?? null

type Night = typeof NIGHT
type Claim = { where: { id: string; next_event_nudged_at?: Date; OR?: { next_event_nudged_at: null | { lte: Date } }[] }; data: { next_event_nudged_at: Date | null } }
function world(o: { night?: Night; attendees?: number; comingUp?: number; members?: { id: string; email: string }[]; nudged?: Date | null } = {}) {
  const night = o.night ?? NIGHT
  nudged.clear()
  nudged.set(ORG, o.nudged ?? null)
  mockDb.events.findMany.mockImplementation(async () => [{ ...night, organizer_org: { next_event_nudged_at: nudgedAt() } }])
  mockDb.events.findFirst.mockResolvedValue({ id: night.id })
  mockDb.events.count.mockResolvedValue(o.comingUp ?? 0)
  mockDb.organisations.updateMany.mockImplementation(async ({ where, data }: Claim) => {
    // As Postgres would apply it. The claim: null, or older than the cutoff (a where without the guard matches always).
    // The give-back: only while the value is still this pass's own claim.
    const current = nudged.get(where.id) ?? null
    const free = where.next_event_nudged_at
      ? current?.getTime() === where.next_event_nudged_at.getTime()
      : !where.OR || where.OR.some((c) => (c.next_event_nudged_at === null ? current === null : !!current && current <= c.next_event_nudged_at.lte))
    if (!free) return { count: 0 }
    nudged.set(where.id, data.next_event_nudged_at)
    return { count: 1 }
  })
  mockDb.organisation_members.findMany.mockResolvedValue((o.members ?? [OWNER, ADMIN]).map((user) => ({ user })))
  mockDb.event_check_ins.findMany.mockResolvedValue(Array.from({ length: o.attendees ?? 42 }, (_, i) => ({ user_id: `a${i}`, kind: "attendee" })))
  mockDb.email_suppressions.findUnique.mockResolvedValue(null)
}

beforeAll(() => {
  process.env.RESEND_API_KEY = "re_test"
  process.env.EMAIL_FROM = "Blend'n <hello@blendn.app>"
  process.env.NEXTAUTH_SECRET = "x".repeat(40)
  process.env.DASHBOARD_HOST = "dashboard.blendn.app"
  global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Sent
    duringSend()
    const status = fetchStatus(body.to[0])
    if (status === 200) sent.push(body)
    return new Response(JSON.stringify({ id: "m" }), { status })
  }) as unknown as typeof fetch
})

beforeEach(() => {
  jest.clearAllMocks()
  sent = []
  fetchStatus = () => 200
  duringSend = () => {}
  delete process.env.EMAIL_REPLY_TO
  world()
})

describe("when", () => {
  it("nothing on day 6 or at 09:59 on day 7, one mail per owner and admin at 10:00 on day 7", async () => {
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() - DAY))).toBe(0)
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() - 60_000))).toBe(0)
    expect(mockDb.organisations.updateMany).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)

    expect(await sendNextNightNudges(DAY7_TEN)).toBe(2)
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["admin@blendn.app", "owner@blendn.app"])
    expect(nudgedAt()).toEqual(DAY7_TEN)
  })

  it("none on day 8 or for the next 30 days: the claim on next_event_nudged_at holds", async () => {
    await sendNextNightNudges(DAY7_TEN)
    expect(sent).toHaveLength(2)
    for (const at of [DAY7_TEN.getTime() + 5 * 60_000, DAY7_TEN.getTime() + DAY - 60_000]) await sendNextNightNudges(new Date(at))
    expect(sent).toHaveLength(2)
    // A newer night ten days on, still with nothing listed: inside 30 days, so nothing.
    world({ night: { ...NIGHT, id: "e-newer", end_time: new Date(NIGHT.end_time.getTime() + 10 * DAY) }, nudged: DAY7_TEN })
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() + 10 * DAY))).toBe(0)
    expect(sent).toHaveLength(2)
  })

  it("a pass that read the org before another claimed it (a second replica) loses the claim and sends nothing", async () => {
    await sendNextNightNudges(DAY7_TEN)
    // Stale read: the night still says never nudged, so only the conditional update can stop it.
    mockDb.events.findMany.mockResolvedValue([{ ...NIGHT, organizer_org: { next_event_nudged_at: null } }])
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() + 5 * 60_000))).toBe(0)
    // The same for a newer night inside 30 days.
    const newer = { ...NIGHT, id: "e-newer", end_time: new Date(NIGHT.end_time.getTime() + 10 * DAY), organizer_org: { next_event_nudged_at: null } }
    mockDb.events.findMany.mockResolvedValue([newer])
    mockDb.events.findFirst.mockResolvedValue({ id: "e-newer" })
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() + 10 * DAY))).toBe(0)
    expect(sent).toHaveLength(2)
  })

  it("one again once 30 days have passed since the last, if still nothing is listed", async () => {
    world({ nudged: new Date(DAY7_TEN.getTime() - 30 * DAY) })
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(2)
    expect(mockDb.organisations.updateMany).toHaveBeenCalledWith({
      where: {
        id: ORG,
        status: { not: "suspended" },
        OR: [{ next_event_nudged_at: null }, { next_event_nudged_at: { lte: new Date(DAY7_TEN.getTime() - 30 * DAY) } }],
      },
      data: { next_event_nudged_at: DAY7_TEN },
    })
  })

  it("never more than a day late: a night whose 10:00 passed a day ago gets nothing (deploy day)", async () => {
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() + DAY))).toBe(0)
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() + DAY + 60_000))).toBe(0)
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() + 14 * DAY))).toBe(0)
    expect(mockDb.organisations.updateMany).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it("follows a Toronto night across the DST change: 10:00 EST a week on, not 10:00 EDT", async () => {
    // Ends 02:00 EDT Sun 2026-10-25; clocks go back at 02:00 Sun 2026-11-01, so 10:00 that day is 15:00Z.
    world({ night: { ...NIGHT, end_time: new Date("2026-10-25T06:00:00Z"), timezone: "America/Toronto" } })
    expect(await sendNextNightNudges(new Date("2026-11-01T14:59:00Z"))).toBe(0)
    expect(await sendNextNightNudges(new Date("2026-11-01T15:00:00Z"))).toBe(2)
  })

  it("a day late less a minute still sends", async () => {
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() + DAY - 60_000))).toBe(2)
  })

  it("asks only for real org nights, held (published or completed), not deleted, that ended 7 to 10 days ago", async () => {
    await sendNextNightNudges(DAY7_TEN)
    const { where } = mockDb.events.findMany.mock.calls[0][0]
    expect(where).toEqual({
      kind: "event",
      organizer_org_id: { not: null },
      status: { in: ["published", "completed"] },
      deleted_at: null,
      end_time: { gt: new Date(DAY7_TEN.getTime() - 10 * DAY), lte: new Date(DAY7_TEN.getTime() - 7 * DAY) },
    })
  })
})

describe("what counts", () => {
  it("an org with a published night not yet over gets nothing, and the question asked is exactly that", async () => {
    world({ comingUp: 1 })
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(0)
    expect(mockDb.organisations.updateMany).not.toHaveBeenCalled()
    expect(mockDb.events.count).toHaveBeenCalledWith({
      where: { kind: "event", organizer_org_id: ORG, status: "published", deleted_at: null, end_time: { gt: DAY7_TEN } },
    })
  })

  it("only the org's latest ended night counts: a later night that has ended means this one is not the last", async () => {
    mockDb.events.findFirst.mockResolvedValue({ id: "e-later" })
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(0)
    expect(mockDb.events.findFirst).toHaveBeenCalledWith({
      where: { kind: "event", organizer_org_id: ORG, status: { in: ["published", "completed"] }, deleted_at: null, end_time: { lte: DAY7_TEN } },
      orderBy: [{ end_time: "desc" }, { id: "desc" }],
      select: { id: true },
    })
  })

  it("two organizations in one pass: a claim and a mail each", async () => {
    const B = "0a000000-0000-4000-8000-00000000000b"
    nudged.set(B, null)
    mockDb.events.findMany.mockResolvedValue([
      { ...NIGHT, organizer_org: { next_event_nudged_at: null } },
      { ...NIGHT, id: "e-b", organizer_org_id: B, organizer_org: { next_event_nudged_at: null } },
    ])
    mockDb.events.findFirst.mockImplementation(async ({ where }: { where: { organizer_org_id: string } }) => ({ id: where.organizer_org_id === B ? "e-b" : NIGHT.id }))
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(4)
    expect(nudged.get(B)).toEqual(DAY7_TEN)
    expect(nudgedAt()).toEqual(DAY7_TEN)
  })

  it("one organization that fails does not stop the next", async () => {
    const B = "0a000000-0000-4000-8000-00000000000b"
    nudged.set(B, null)
    mockDb.events.findMany.mockResolvedValue([
      { ...NIGHT, organizer_org: { next_event_nudged_at: null } },
      { ...NIGHT, id: "e-b", organizer_org_id: B, organizer_org: { next_event_nudged_at: null } },
    ])
    mockDb.events.findFirst.mockImplementation(async ({ where }: { where: { organizer_org_id: string } }) => {
      if (where.organizer_org_id === ORG) throw new Error("db blip")
      return { id: "e-b" }
    })
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(2)
    expect(nudged.get(B)).toEqual(DAY7_TEN)
    expect(nudgedAt()).toBeNull()
  })

  it("two nights of one org in the window: one claim, for the later one", async () => {
    const earlier = { ...NIGHT, id: "e-earlier", end_time: new Date(NIGHT.end_time.getTime() - 3_600_000) }
    mockDb.events.findMany.mockResolvedValue([NIGHT, earlier].map((n) => ({ ...n, organizer_org: { next_event_nudged_at: null } })))
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(2)
    expect(mockDb.organisations.updateMany).toHaveBeenCalledTimes(1)
  })
})

describe("who", () => {
  it("owners and admins by membership, not deleted, not suspended", async () => {
    await sendNextNightNudges(DAY7_TEN)
    expect(mockDb.organisation_members.findMany).toHaveBeenCalledWith({
      where: { org_id: ORG, role: { in: ["owner", "admin"] }, user: { deletedAt: null, suspended_at: null } },
      select: { user: { select: { id: true, email: true } } },
    })
  })

  it.each(["unsubscribe", "bounce"])("an owner with a %s row is skipped; the admin still gets theirs", async (reason) => {
    mockDb.email_suppressions.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
      where.email === "owner@blendn.app" ? { reason } : null
    )
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(1)
    expect(sent.map((m) => m.to[0])).toEqual(["admin@blendn.app"])
  })

  it("a night nobody got because the provider failed is given back for the next pass", async () => {
    fetchStatus = () => 422
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(0)
    expect(nudgedAt()).toBeNull()
    fetchStatus = () => 200
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() + 5 * 60_000))).toBe(2)
  })

  it("the give-back only undoes this pass's own claim, never a value written since", async () => {
    const since = new Date(DAY7_TEN.getTime() + 1)
    fetchStatus = () => 422
    duringSend = () => nudged.set(ORG, since)
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(0)
    expect(nudgedAt()).toEqual(since)
  })

  it("a partial send keeps the claim: the owner who got it is not mailed twice", async () => {
    fetchStatus = (to) => (to === "owner@blendn.app" ? 422 : 200)
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(1)
    expect(nudgedAt()).toEqual(DAY7_TEN)
    fetchStatus = () => 200
    mockDb.events.findMany.mockResolvedValue([{ ...NIGHT, organizer_org: { next_event_nudged_at: null } }])
    expect(await sendNextNightNudges(new Date(DAY7_TEN.getTime() + 5 * 60_000))).toBe(0)
    expect(sent.map((m) => m.to[0])).toEqual(["admin@blendn.app"])
  })

  it("a send that throws gives the claim back", async () => {
    mockDb.organisation_members.findMany.mockRejectedValue(new Error("db blip"))
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(0)
    expect(nudgedAt()).toBeNull()
  })

  it("an org with no owner or admin left is claimed and mails nobody, so it is not asked again every pass", async () => {
    world({ members: [] })
    expect(await sendNextNightNudges(DAY7_TEN)).toBe(0)
    expect(nudgedAt()).toEqual(DAY7_TEN)
  })

  it("never throws", async () => {
    mockDb.events.findMany.mockRejectedValue(new Error("db down"))
    await expect(sendNextNightNudges(DAY7_TEN)).resolves.toBe(0)
  })
})

describe("the mail", () => {
  const only = () => sent.find((m) => m.to[0] === "owner@blendn.app")!

  it("one line on the night with its figure, one button to a new event, the lifecycle headers and tag", async () => {
    await sendNextNightNudges(DAY7_TEN)
    const m = only()
    expect(m.subject).toBe("Friday at Toit: what’s next?")
    expect(m.text).toContain("42 people checked in on Blend’n at Friday at Toit last week. Nothing is listed after it yet.")
    expect(m.text).toContain("List your next night:\nhttps://dashboard.blendn.app/dashboard/events/new")
    expect(m.html).toContain('href="https://dashboard.blendn.app/dashboard/events/new"')
    // One button (the shell's button cell), and no second link beside it.
    expect(m.html.match(/padding:13px 30px/g)).toHaveLength(1)
    expect(m.html.match(/href="https:\/\/dashboard\.blendn\.app\/dashboard\/(?!events\/new")/g)).toBeNull()
    expect(m.tags).toEqual([{ name: "kind", value: "next_night" }])
    expect(m.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/dashboard\.blendn\.app\/api\/email\/unsubscribe\?t=u-owner\.[\w%-]+>$/)
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    for (const part of [m.text, m.html]) {
      expect(part).toContain("You get this a week after a night with nothing listed next, at most once a month.")
      expect(part).not.toContain("the morning after")
    }
    expect(m.html).toContain("Unsubscribe from these mails")
    // No second ask, no lever, no price, no programme.
    expect(`${m.subject}\n${m.text}\n${m.html}`).not.toMatch(/Plus|free|founding|price|₹|\$|results page/i)
  })

  it("12,480 checked in and a long title", async () => {
    world({ night: { ...NIGHT, title: "Thiruvananthapuram Indie Night: Third Edition Rooftop Session" }, attendees: 12_480 })
    await sendNextNightNudges(DAY7_TEN)
    expect(only().text).toContain("12,480 people checked in on Blend’n at Thiruvananthapuram Indie Night: Third Edition Rooftop Session last week.")
  })

  it("5 checked in is a number", async () => {
    world({ attendees: 5 })
    await sendNextNightNudges(DAY7_TEN)
    expect(only().text).toContain("5 people checked in on Blend’n at Friday at Toit last week.")
    expect(only().text).not.toContain("Fewer than")
  })

  it("fewer than 5 checked in: the floor, never the number", async () => {
    world({ attendees: 4 })
    await sendNextNightNudges(DAY7_TEN)
    expect(only().text).toContain("Fewer than 5 people checked in on Blend’n at Friday at Toit last week.")
    expect(only().text).not.toMatch(/\b4 people/)
  })

  it("nobody checked in: no number at all", async () => {
    world({ attendees: 0 })
    await sendNextNightNudges(DAY7_TEN)
    expect(only().text).toContain("It’s a week since Friday at Toit, and nothing is listed after it yet.")
    expect(only().text).not.toMatch(/people|checked in/)
  })

  it("the title is escaped in the HTML", async () => {
    world({ night: { ...NIGHT, title: "<b>Night</b> & co" } })
    await sendNextNightNudges(DAY7_TEN)
    expect(only().html).toContain("&lt;b&gt;Night&lt;/b&gt; &amp; co")
    expect(only().html).not.toContain("<b>Night</b>")
  })
})
