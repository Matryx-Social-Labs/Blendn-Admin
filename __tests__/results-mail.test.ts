/*
 * The host's morning results mail (SCRUM-1282, launch gate 14): once per org event, to the org's owners and admins,
 * at 10:00 on the event's clock the morning after it ends, free figures only, with a one-click unsubscribe.
 *
 * Every way it can be wrong is silent: sent at 01:00, sent twice, a figure under the floor printed, an owner who
 * unsubscribed mailed anyway, or one owner's failed send costing the other owner theirs.
 */
const mockDb = {
  events: { findMany: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  organisation_members: { findMany: jest.fn() },
  event_check_ins: { findMany: jest.fn() },
  event_feedback: { count: jest.fn() },
  email_suppressions: { findUnique: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockRatingGroups = jest.fn()
jest.mock("@/lib/rating-batches", () => ({ publishedRatingGroups: (...a: unknown[]) => mockRatingGroups(...a) }))

import { RESULTS_MAIL_ENDED_WITHIN_MS, sendResultsMails } from "@/lib/results-mail"
import { verifyUnsubscribeToken } from "@/lib/unsubscribe"

const ORG = "0a000000-0000-4000-8000-000000000001"
/** Ended 23:00 IST Thu 2026-11-26: mailed at 10:00 IST Fri 2026-11-27 (04:30Z). */
const EVENT = {
  id: "e0000000-0000-4000-8000-000000000001",
  title: "Friday at Toit",
  end_time: new Date("2026-11-26T17:30:00Z"),
  timezone: "Asia/Kolkata",
  organizer_org_id: ORG,
}
const TEN_IST = new Date("2026-11-27T04:30:00Z")
const OWNER = { id: "u-owner", email: "owner@blendn.app" }
const ADMIN = { id: "u-admin", email: "Admin@Blendn.app " }

type Sent = { to: string[]; subject: string; text: string; html: string; headers: Record<string, string>; tags: { name: string; value: string }[] }
let sent: Sent[] = []
let fetchStatus: (to: string) => number = () => 200

/** `results_mailed_at` as the database would keep it: the conditional update wins once. */
let mailedAt: Date | null = null

function world(o: { attendees?: number; raters?: [number, number, number, number, number]; feedback?: number; members?: { id: string; email: string }[] } = {}) {
  mailedAt = null
  mockDb.events.findMany.mockImplementation(async () => (mailedAt ? [] : [EVENT]))
  mockDb.events.updateMany.mockImplementation(async (args: { where: { results_mailed_at: null }; data: { results_mailed_at: Date } }) => {
    if (mailedAt) return { count: 0 }
    mailedAt = args.data.results_mailed_at
    return { count: 1 }
  })
  mockDb.events.count.mockResolvedValue(0)
  mockDb.organisation_members.findMany.mockResolvedValue((o.members ?? [OWNER, ADMIN]).map((user) => ({ user })))
  mockDb.event_check_ins.findMany.mockResolvedValue(
    Array.from({ length: o.attendees ?? 42 }, (_, i) => ({ user_id: `a${i}`, kind: "attendee" }))
  )
  const spread = o.raters ?? [0, 0, 0, 0, 0]
  mockRatingGroups.mockResolvedValue(
    spread.flatMap((n, i) => (n ? [{ event_id: EVENT.id, rating: i + 1, _count: { _all: n } }] : []))
  )
  mockDb.event_feedback.count.mockResolvedValue(o.feedback ?? 0)
  mockDb.email_suppressions.findUnique.mockResolvedValue(null)
}

beforeAll(() => {
  process.env.RESEND_API_KEY = "re_test"
  process.env.EMAIL_FROM = "Blend'n <hello@blendn.app>"
  process.env.NEXTAUTH_SECRET = "x".repeat(40)
  process.env.DASHBOARD_HOST = "dashboard.blendn.app"
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
  delete process.env.EMAIL_REPLY_TO
  world()
})

describe("when", () => {
  it("is not sent before 10:00 on the event's clock, and is sent at 10:00", async () => {
    expect(await sendResultsMails(new Date(TEN_IST.getTime() - 60_000))).toBe(0)
    expect(mockDb.events.updateMany).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)

    expect(await sendResultsMails(TEN_IST)).toBe(2)
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["admin@blendn.app", "owner@blendn.app"])
  })

  it("follows a Toronto night across the DST change: 10:00 EST, not 10:00 EDT", async () => {
    // Ends 23:00 EDT Sat 2026-10-31; clocks go back at 02:00 Sun 2026-11-01, so 10:00 that day is 15:00Z.
    const toronto = { ...EVENT, end_time: new Date("2026-11-01T03:00:00Z"), timezone: "America/Toronto" }
    mockDb.events.findMany.mockImplementation(async () => (mailedAt ? [] : [toronto]))
    expect(await sendResultsMails(new Date("2026-11-01T14:59:00Z"))).toBe(0)
    expect(await sendResultsMails(new Date("2026-11-01T15:00:00Z"))).toBe(2)
  })

  it("is sent once across two passes: the claim is a conditional update before the send", async () => {
    await sendResultsMails(TEN_IST)
    // A second pass that still sees the row (a replica that read before the claim) loses the update and sends nothing.
    mockDb.events.findMany.mockResolvedValue([EVENT])
    await sendResultsMails(new Date(TEN_IST.getTime() + 5 * 60_000))
    expect(sent).toHaveLength(2)
    expect(mockDb.events.updateMany).toHaveBeenLastCalledWith({
      where: { id: EVENT.id, results_mailed_at: null },
      data: { results_mailed_at: expect.any(Date) },
    })
  })

  it("asks only for org events, real ones, published or completed, ended in the last 34 h and not yet mailed", async () => {
    await sendResultsMails(TEN_IST)
    const { where } = mockDb.events.findMany.mock.calls[0][0]
    expect(where).toMatchObject({
      kind: "event",
      organizer_org_id: { not: null },
      status: { in: ["published", "completed"] },
      deleted_at: null,
      results_mailed_at: null,
      end_time: { lte: TEN_IST, gt: new Date(TEN_IST.getTime() - RESULTS_MAIL_ENDED_WITHIN_MS) },
    })
    expect(RESULTS_MAIL_ENDED_WITHIN_MS).toBe(34 * 3600_000)
  })
})

describe("who", () => {
  it("reads owners and admins from organisation membership, never events.organizer_id", async () => {
    await sendResultsMails(TEN_IST)
    const { where } = mockDb.organisation_members.findMany.mock.calls[0][0]
    expect(where).toMatchObject({ org_id: ORG, role: { in: ["owner", "admin"] }, user: { deletedAt: null } })
  })

  it("skips a suppressed owner and still mails the other", async () => {
    mockDb.email_suppressions.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
      where.email === "owner@blendn.app" ? { reason: "unsubscribe" } : null
    )
    expect(await sendResultsMails(TEN_IST)).toBe(1)
    expect(sent.map((m) => m.to[0])).toEqual(["admin@blendn.app"])
  })

  it("one owner's failed send does not stop the other's", async () => {
    world({ members: [OWNER, { id: "u-owner2", email: "owner2@blendn.app" }] })
    fetchStatus = (to) => (to === "owner@blendn.app" ? 422 : 200)
    expect(await sendResultsMails(TEN_IST)).toBe(1)
    expect(sent.map((m) => m.to[0])).toEqual(["owner2@blendn.app"])
  })

  it("an org with nobody left to mail is claimed and mails nobody", async () => {
    world({ members: [] })
    expect(await sendResultsMails(TEN_IST)).toBe(0)
    expect(mailedAt).not.toBeNull()
  })
})

describe("what", () => {
  it("12,480 checked in, a long title, the rating once 5 rated, the mood count; one button to the Overview", async () => {
    const title = "Thiruvananthapuram Indie Night: Third Edition Rooftop Session"
    mockDb.events.findMany.mockImplementation(async () => (mailedAt ? [] : [{ ...EVENT, title }]))
    world({ attendees: 12480, raters: [0, 1, 2, 4, 5], feedback: 318 })
    mockDb.events.findMany.mockImplementation(async () => (mailedAt ? [] : [{ ...EVENT, title }]))
    await sendResultsMails(TEN_IST)
    const [mail] = sent
    expect(mail.subject).toBe(`${title}: your night in numbers`)
    expect(mail.text).toContain("12,480 people checked in on Blend’n")
    expect(mail.text).toContain("4.1 average rating from 12 people")
    expect(mail.text).toContain("318 room messages read for the night’s mood")
    expect(mail.text).toContain(`https://dashboard.blendn.app/dashboard/events/${EVENT.id}\n`)
    expect(mail.text).toContain("https://dashboard.blendn.app/dashboard/events/new")
    expect(mail.html).toContain("12,480")
    // One button (the bulletproof table cell), one plain "List your next" link.
    expect(mail.html.match(/bgcolor="#F05423"/g)).toHaveLength(1)
    expect(mail.html.match(/List your next night/g)).toHaveLength(1)
    expect(mail.html).not.toMatch(/Blend’n\+|Blend&rsquo;n\+|Plus|free month/i)
  })

  it("fewer than 5 checked in shows the floor text and never the number", async () => {
    world({ attendees: 3, raters: [0, 0, 1, 1, 0], feedback: 2 })
    await sendResultsMails(TEN_IST)
    const [mail] = sent
    expect(mail.text).toContain("Fewer than 5 people checked in on Blend’n")
    expect(mail.text).not.toMatch(/\b3 people/)
    // Two raters: no average, and the count is not said either.
    expect(mail.text).not.toMatch(/average rating from/)
    expect(mail.text).toContain("The average shows on the Overview once 5 people have rated")
    expect(mail.text).toContain("“fewer than 5”, so nobody can be picked out")
    expect(mail.html).toContain("Fewer than 5 people")
  })

  it("carries one-click unsubscribe headers, the lifecycle tag, and no mailto without a reply inbox", async () => {
    await sendResultsMails(TEN_IST)
    const [mail] = sent
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    expect(mail.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/dashboard\.blendn\.app\/api\/email\/unsubscribe\?t=[^>]+>$/)
    expect(mail.tags).toEqual([{ name: "kind", value: "results" }])
    // The address is not in the URL.
    expect(mail.headers["List-Unsubscribe"]).not.toContain("blendn.app/api/email/unsubscribe?t=owner")
    expect(decodeURIComponent(mail.headers["List-Unsubscribe"])).not.toMatch(/@blendn\.app/)
    expect(mail.text).toContain("Unsubscribe from these mails:")
  })

  it("adds a mailto only when a reply inbox exists", async () => {
    process.env.EMAIL_REPLY_TO = "hello@blendn.app"
    await sendResultsMails(TEN_IST)
    expect(sent[0].headers["List-Unsubscribe"]).toMatch(/^<https:[^>]+>, <mailto:hello@blendn\.app\?subject=unsubscribe>$/)
  })

  it("each recipient's link is their own token, over their canonical address", async () => {
    await sendResultsMails(TEN_IST)
    for (const mail of sent) {
      const token = decodeURIComponent(/\?t=([^>]+)>/.exec(mail.headers["List-Unsubscribe"])![1])
      const user = mail.to[0] === "owner@blendn.app" ? OWNER : ADMIN
      expect(verifyUnsubscribeToken(token, { id: user.id, email: user.email })).toBe(true)
      const other = user === OWNER ? ADMIN : OWNER
      expect(verifyUnsubscribeToken(token, { id: user.id, email: other.email })).toBe(false)
    }
  })
})

describe("zero check-ins (Fable advisor pick, 2026-11-26)", () => {
  it("the org's first mailed night: one 'no check-ins on Blend’n' mail with the door QR step", async () => {
    world({ attendees: 0 })
    await sendResultsMails(TEN_IST)
    expect(sent).toHaveLength(2)
    expect(sent[0].subject).toBe("Friday at Toit: no check-ins on Blend’n")
    expect(sent[0].text).toContain("Nobody checked in on Blend’n at Friday at Toit")
    expect(sent[0].text).toContain("“QR & link”")
    expect(sent[0].text).toContain("/dashboard/events/new")
    expect(sent[0].tags).toEqual([{ name: "kind", value: "results" }])
  })

  it("an org already mailed for another night: claimed, and silent", async () => {
    world({ attendees: 0 })
    mockDb.events.count.mockResolvedValue(1)
    expect(await sendResultsMails(TEN_IST)).toBe(0)
    expect(sent).toHaveLength(0)
    expect(mailedAt).not.toBeNull()
    expect(mockDb.events.count.mock.calls[0][0].where).toMatchObject({
      organizer_org_id: ORG,
      id: { not: EVENT.id },
      results_mailed_at: { not: null },
    })
  })
})

it("never throws: it runs on a timer in the server process", async () => {
  mockDb.events.findMany.mockRejectedValue(new Error("db down"))
  await expect(sendResultsMails(TEN_IST)).resolves.toBe(0)
})
