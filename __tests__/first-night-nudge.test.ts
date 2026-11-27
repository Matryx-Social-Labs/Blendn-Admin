/*
 * The first-night nudge (SCRUM-1342): an organizer approved three days ago with nothing listed gets one mail, to the
 * organization's owners and admins, at the first 10:00 on its own clock a full three days after approval. It shares
 * 04c's claim (`organisations.next_event_nudged_at`), so it is once, and the two nudges stay 30 days apart.
 *
 * Every way it can be wrong is silent: sent at 02:00, sent on day 2, sent every pass, sent on deploy day to hosts
 * approved weeks ago, or to an owner who unsubscribed. Which organizations qualify (any event, suspended, venue-only,
 * already nudged) is decided by the database: integration/first-night-nudge.itest.ts proves that half.
 */
const mockDb = {
  organiser_onboarding_requests: { findMany: jest.fn() },
  organisations: { updateMany: jest.fn() },
  organisation_members: { findMany: jest.fn() },
  email_suppressions: { findUnique: jest.fn() },
  markets: { findMany: jest.fn() },
  cities: { findMany: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

import { sendFirstNightNudges } from "@/lib/next-night-nudge"

const ORG = "0a000000-0000-4000-8000-000000000009"
const DAY = 86_400_000
/** Approved 08:00 IST Mon 2026-11-23: three days on is 08:00 Thu, so 10:00 IST Thu 2026-11-26 (04:30Z). */
const APPROVED = new Date("2026-11-23T02:30:00Z")
const DAY3_TEN = new Date("2026-11-26T04:30:00Z")
const OWNER = { id: "u-owner", email: "owner@blendn.app" }
const ADMIN = { id: "u-admin", email: "Admin@Blendn.app " }

type Approval = { org_id: string; reviewed_at: Date; city: string | null; org: { display_name: string } }
const APPROVAL: Approval = { org_id: ORG, reviewed_at: APPROVED, city: "Bengaluru", org: { display_name: "Byg Brewski" } }

const city = (o: { id: string; market: string; slug: string; name: string; tz: string; lat: number; lon: number }) => ({
  id: o.id,
  market_code: o.market,
  slug: o.slug,
  name: o.name,
  match_names: [],
  timezone: o.tz,
  launch_state: "live",
  is_default: true,
  centre_lat: o.lat,
  centre_lon: o.lon,
  min_lat: o.lat - 1,
  min_lon: o.lon - 1,
  max_lat: o.lat + 1,
  max_lon: o.lon + 1,
  sort: 0,
})

type Sent = { to: string[]; subject: string; text: string; html: string; headers: Record<string, string>; tags: { name: string; value: string }[] }
let sent: Sent[] = []
let fetchStatus: (to: string) => number = () => 200

/** `organisations.next_event_nudged_at` per organization; the conditional update is its only writer. */
const nudged = new Map<string, Date | null>()
const nudgedAt = (id = ORG) => nudged.get(id) ?? null

type Claim = { where: { id: string; next_event_nudged_at?: Date; OR?: { next_event_nudged_at: null | { lte: Date } }[] }; data: { next_event_nudged_at: Date | null } }
function world(o: { approvals?: Approval[]; members?: { id: string; email: string }[] } = {}) {
  const approvals = o.approvals ?? [APPROVAL]
  nudged.clear()
  for (const a of approvals) nudged.set(a.org_id, null)
  mockDb.organiser_onboarding_requests.findMany.mockResolvedValue(approvals)
  mockDb.organisations.updateMany.mockImplementation(async ({ where, data }: Claim) => {
    // As Postgres would apply it: the claim (null, or older than the cutoff), and the give-back (only its own claim).
    const current = nudged.get(where.id) ?? null
    const free = where.next_event_nudged_at
      ? current?.getTime() === where.next_event_nudged_at.getTime()
      : !where.OR || where.OR.some((c) => (c.next_event_nudged_at === null ? current === null : !!current && current <= c.next_event_nudged_at.lte))
    if (!free) return { count: 0 }
    nudged.set(where.id, data.next_event_nudged_at)
    return { count: 1 }
  })
  mockDb.organisation_members.findMany.mockResolvedValue((o.members ?? [OWNER, ADMIN]).map((user) => ({ user })))
  mockDb.email_suppressions.findUnique.mockResolvedValue(null)
}

beforeAll(() => {
  process.env.RESEND_API_KEY = "re_test"
  process.env.EMAIL_FROM = "Blend'n <hello@blendn.app>"
  process.env.NEXTAUTH_SECRET = "x".repeat(40)
  process.env.DASHBOARD_HOST = "dashboard.blendn.app"
  mockDb.markets.findMany.mockResolvedValue([
    { code: "IN", name: "India", launch_state: "live", sort: 0 },
    { code: "CA", name: "Canada", launch_state: "live", sort: 1 },
  ])
  mockDb.cities.findMany.mockResolvedValue([
    city({ id: "c-blr", market: "IN", slug: "bengaluru", name: "Bengaluru", tz: "Asia/Kolkata", lat: 12.97, lon: 77.59 }),
    city({ id: "c-yyz", market: "CA", slug: "toronto", name: "Toronto", tz: "America/Toronto", lat: 43.65, lon: -79.38 }),
  ])
  global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Sent
    const status = fetchStatus(body.to[0])
    if (status === 200) sent.push(body)
    return new Response(JSON.stringify({ id: "m" }), { status })
  }) as unknown as typeof fetch
})

beforeEach(() => {
  jest.clearAllMocks()
  sent = []
  fetchStatus = () => 200
  world()
})

describe("when", () => {
  it("nothing on day 2 or at 09:59 on day 3; one mail to each owner and admin at 10:00 on day 3", async () => {
    expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() - DAY))).toBe(0)
    expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() - 60_000))).toBe(0)
    expect(mockDb.organisations.updateMany).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)

    expect(await sendFirstNightNudges(DAY3_TEN)).toBe(2)
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["admin@blendn.app", "owner@blendn.app"])
    expect(nudgedAt()).toEqual(DAY3_TEN)
  })

  it("a full three days: approved at 11:00, the 10:00 three days on is an hour short, so it is the next morning's", async () => {
    world({ approvals: [{ ...APPROVAL, reviewed_at: new Date(APPROVED.getTime() + 3 * 3600_000) }] })
    expect(await sendFirstNightNudges(DAY3_TEN)).toBe(0)
    expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() + DAY))).toBe(2)
  })

  it("once: a pass that read the organization before another claimed it (a second replica) sends nothing", async () => {
    expect(await sendFirstNightNudges(DAY3_TEN)).toBe(2)
    // Stale read: the approval is still returned as never nudged, so only the conditional update can stop it.
    expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() + 5 * 60_000))).toBe(0)
    expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() + DAY - 60_000))).toBe(0)
    expect(sent).toHaveLength(2)
  })

  it("none on day 4 or later: never more than a day late, so deploy day mails nobody approved weeks ago", async () => {
    for (const at of [DAY, DAY + 60_000, 14 * DAY]) expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() + at))).toBe(0)
    expect(mockDb.organisations.updateMany).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it("a day late less a minute still sends", async () => {
    expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() + DAY - 60_000))).toBe(2)
  })

  it("on a Toronto organization's clock across the DST change: 10:00 EST, not 10:00 EDT", async () => {
    // Approved 08:00 EDT Thu 2026-10-29; clocks go back at 02:00 Sun 2026-11-01, so 10:00 that day is 15:00Z.
    world({ approvals: [{ ...APPROVAL, city: "Toronto", reviewed_at: new Date("2026-10-29T12:00:00Z") }] })
    expect(await sendFirstNightNudges(new Date("2026-11-01T14:00:00Z"))).toBe(0)
    expect(await sendFirstNightNudges(new Date("2026-11-01T14:59:00Z"))).toBe(0)
    expect(await sendFirstNightNudges(new Date("2026-11-01T15:00:00Z"))).toBe(2)
  })

  it("a full 72 hours across the spring-forward change, not three wall-clock days", async () => {
    // Approved 09:30 EST Thu 2026-03-05; clocks go forward at 02:00 Sun 2026-03-08, so 72 h on is 10:30 EDT Sunday and
    // the first 10:00 after it is Monday's (14:00Z), not Sunday's.
    world({ approvals: [{ ...APPROVAL, city: "Toronto", reviewed_at: new Date("2026-03-05T14:30:00Z") }] })
    expect(await sendFirstNightNudges(new Date("2026-03-08T14:00:00Z"))).toBe(0)
    expect(await sendFirstNightNudges(new Date("2026-03-09T13:59:00Z"))).toBe(0)
    expect(await sendFirstNightNudges(new Date("2026-03-09T14:00:00Z"))).toBe(2)
  })

  it.each([null, "Atlantis"])("an application with city %p reads as India's clock", async (cityName) => {
    world({ approvals: [{ ...APPROVAL, city: cityName }] })
    expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() - 60_000))).toBe(0)
    expect(await sendFirstNightNudges(DAY3_TEN)).toBe(2)
  })

  it("asks for approved organizer applications 3 to 6 days old whose organization has no event at all, is not suspended and was never nudged", async () => {
    await sendFirstNightNudges(DAY3_TEN)
    expect(mockDb.organiser_onboarding_requests.findMany).toHaveBeenCalledWith({
      where: {
        status: "approved",
        requested_role: "organizer",
        reviewed_at: { gt: new Date(DAY3_TEN.getTime() - 6 * DAY), lte: new Date(DAY3_TEN.getTime() - 3 * DAY) },
        org: { status: { not: "suspended" }, suspended_at: null, next_event_nudged_at: null, events: { none: {} } },
      },
      select: { org_id: true, reviewed_at: true, city: true, org: { select: { display_name: true } } },
    })
  })
})

describe("who", () => {
  it("owners and admins by membership, not deleted, not suspended", async () => {
    await sendFirstNightNudges(DAY3_TEN)
    expect(mockDb.organisation_members.findMany).toHaveBeenCalledWith({
      where: { org_id: ORG, role: { in: ["owner", "admin"] }, user: { deletedAt: null, suspended_at: null } },
      select: { user: { select: { id: true, email: true } } },
    })
  })

  it("two owners: one mail each", async () => {
    world({ members: [OWNER, { id: "u-owner2", email: "second@blendn.app" }] })
    expect(await sendFirstNightNudges(DAY3_TEN)).toBe(2)
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["owner@blendn.app", "second@blendn.app"])
  })

  it.each(["unsubscribe", "bounce", "complaint"])("an owner with a %s row is skipped; the admin still gets theirs", async (reason) => {
    mockDb.email_suppressions.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
      where.email === "owner@blendn.app" ? { reason } : null
    )
    expect(await sendFirstNightNudges(DAY3_TEN)).toBe(1)
    expect(sent.map((m) => m.to[0])).toEqual(["admin@blendn.app"])
  })

  it("two organizations in one pass, and one whose claim throws does not stop the next", async () => {
    const B = "0a000000-0000-4000-8000-00000000000b"
    world({ approvals: [APPROVAL, { ...APPROVAL, org_id: B }] })
    const claim = mockDb.organisations.updateMany.getMockImplementation()!
    mockDb.organisations.updateMany.mockImplementation(async (args: Claim) => {
      if (args.where.id === ORG) throw new Error("db blip")
      return claim(args)
    })
    expect(await sendFirstNightNudges(DAY3_TEN)).toBe(2)
    expect(nudgedAt(B)).toEqual(DAY3_TEN)
    expect(nudgedAt()).toBeNull()
  })

  it("a send that throws gives the claim back, so the next pass tries again", async () => {
    mockDb.organisation_members.findMany.mockRejectedValueOnce(new Error("db blip"))
    expect(await sendFirstNightNudges(DAY3_TEN)).toBe(0)
    expect(nudgedAt()).toBeNull()
    expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() + 5 * 60_000))).toBe(2)
  })

  it("a mail Resend refused for everyone gives the claim back, and the next pass sends it", async () => {
    fetchStatus = () => 422
    expect(await sendFirstNightNudges(DAY3_TEN)).toBe(0)
    expect(nudgedAt()).toBeNull()
    fetchStatus = () => 200
    expect(await sendFirstNightNudges(new Date(DAY3_TEN.getTime() + 5 * 60_000))).toBe(2)
  })

  it("never throws", async () => {
    mockDb.organiser_onboarding_requests.findMany.mockRejectedValue(new Error("db down"))
    await expect(sendFirstNightNudges(DAY3_TEN)).resolves.toBe(0)
  })
})

describe("the mail", () => {
  const only = () => sent.find((m) => m.to[0] === "owner@blendn.app")!

  it("one button to a new event, one line on the morning results mail, the lifecycle headers and tag", async () => {
    await sendFirstNightNudges(DAY3_TEN)
    const m = only()
    expect(m.subject).toBe("List your first night on Blend’n")
    expect(m.text).toContain("Byg Brewski is set up on Blend’n, and nothing is listed yet.")
    expect(m.text).toContain(
      "The morning after each night, you’ll get an email with how it went: how many people checked in, the average rating once 5 people have rated, and, once people have chatted, the room’s mood on the results page."
    )
    expect(m.text).toContain("Create your first event:\nhttps://dashboard.blendn.app/dashboard/events/new")
    expect(m.html).toContain('href="https://dashboard.blendn.app/dashboard/events/new"')
    // One button (the shell's button cell), and no other dashboard link beside it.
    expect(m.html.match(/padding:13px 30px/g)).toHaveLength(1)
    expect(m.html.match(/href="https:\/\/dashboard\.blendn\.app\/dashboard\/(?!events\/new")/g)).toBeNull()
    expect(m.tags).toEqual([{ name: "kind", value: "first_night" }])
    expect(m.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/dashboard\.blendn\.app\/api\/email\/unsubscribe\?t=u-owner\.[\w%-]+>$/)
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    for (const part of [m.text, m.html]) {
      expect(part).toContain("You get this once, three days after your organization was approved, if nothing is listed yet.")
      expect(part).not.toMatch(/organis/i)
    }
    expect(m.html).toContain("Unsubscribe from these mails")
    // No lever, no price, no programme, no figure we do not have.
    expect(`${m.subject}\n${m.text}\n${m.html}`).not.toMatch(/Plus|free|founding|price|₹|\$/i)
    // The only figure in the copy is 5, the rating rule's own floor (04b); no percentage or count we do not have.
    const copy = m.text.replace(/https:\/\/\S+/g, "")
    expect(copy.match(/\d+/g)).toEqual(["5"])
  })

  it("a long organization name, escaped in the HTML", async () => {
    world({ approvals: [{ ...APPROVAL, org: { display_name: "Thiruvananthapuram Indie Collective & <Rooftop> Sessions" } }] })
    await sendFirstNightNudges(DAY3_TEN)
    expect(only().text).toContain("Thiruvananthapuram Indie Collective & <Rooftop> Sessions is set up on Blend’n")
    expect(only().html).toContain("Thiruvananthapuram Indie Collective &amp; &lt;Rooftop&gt; Sessions")
    expect(only().html).not.toContain("<Rooftop>")
  })
})
