/*
 * SCRUM-1275: one mail, 14 days before an organisation's free Analytics ends,
 * to its owners and admins, claimed before it is sent so a second pass (or a
 * second replica) sends nothing. On a db:migrate database: the market rule
 * reads the seeded city catalogue (Bengaluru is India, Toronto is Canada).
 */
const mockSendEmail = jest.fn()
jest.mock("@/lib/email", () => ({
  ...jest.requireActual("@/lib/email"),
  sendEmail: (...a: unknown[]) => mockSendEmail(...a),
}))

import { grantEntitlement } from "@/lib/entitlements"
import { sendFreeWindowEndingMail } from "@/lib/free-window-mail"
import { db as appDb } from "@/lib/db"
import { logger } from "@/lib/logger"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

const DAY = 24 * 60 * 60 * 1000
const now = new Date()
const users: string[] = []
const events: string[] = []
const orgs: string[] = []

interface Night {
  city: string
  deleted?: boolean
  status?: "draft" | "completed"
}

async function orgEndingIn(endsInMs: number, nights: Night[], label: string, status: "verified" | "suspended" = "verified") {
  const owner = await makeUser(testId(`fw-${label}-owner`), "organizer")
  const admin = await makeUser(testId(`fw-${label}-admin`), "organizer")
  const staff = await makeUser(testId(`fw-${label}-staff`), "organizer")
  const gone = await makeUser(testId(`fw-${label}-gone`), "organizer")
  users.push(owner, admin, staff, gone)
  await db.user.update({ where: { id: gone }, data: { deletedAt: now } })
  const org = await db.organisations.create({
    data: {
      kind: "company",
      display_name: testId(`fw-${label}`),
      status,
      analytics_free_until: new Date(now.getTime() + endsInMs),
    },
  })
  orgs.push(org.id)
  for (const [user_id, role] of [[owner, "owner"], [admin, "admin"], [staff, "staff"], [gone, "admin"]] as const) {
    await db.organisation_members.create({ data: { org_id: org.id, user_id, role } })
  }
  for (const [i, night] of nights.entries()) {
    const start = new Date(now.getTime() - (80 - i) * DAY)
    const e = await db.events.create({
      data: {
        slug: testId(`fw-${label}-night${i}`),
        title: `Free window ${label} ${i}`,
        description: "fixture",
        start_time: start,
        end_time: new Date(start.getTime() + 3 * 60 * 60 * 1000),
        timezone: "Asia/Kolkata",
        city: night.city,
        status: night.status ?? "completed",
        deleted_at: night.deleted ? now : null,
        organizer_id: owner,
        organizer_org_id: org.id,
      },
    })
    events.push(e.id)
  }
  const email = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } })).email
  return { id: org.id, owner: await email(owner), admin: await email(admin), staff: await email(staff), gone: await email(gone) }
}

type Org = Awaited<ReturnType<typeof orgEndingIn>>
const BLR: Night[] = [{ city: "Bengaluru" }]

const mailedFor = (org: Org, calls: unknown[][] = mockSendEmail.mock.calls) =>
  calls
    .map(([m]) => (m as { to: string }).to)
    .filter((to) => [org.owner, org.admin, org.staff, org.gone].includes(to))
    .sort()

const markOf = async (orgId: string) =>
  (await db.organisations.findUniqueOrThrow({ where: { id: orgId }, select: { analytics_free_ending_mailed_at: true } }))
    .analytics_free_ending_mailed_at

const sent = { sent: true, id: "re_test" }

afterEach(() => {
  mockSendEmail.mockReset()
  mockSendEmail.mockResolvedValue(sent)
  jest.restoreAllMocks()
})

afterAll(async () => {
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await appDb.$disconnect()
  await closeDb()
})

describe("one pass over organisations at every distance from their end", () => {
  let due: Org, edge: Org, later: Org, granted: Org, ended: Org, canada: Org, suspended: Org
  let uncatalogued: Org, deletedToronto: Org, torontoDraft: Org
  let count = 0
  let first: unknown[][] = []

  beforeAll(async () => {
    due = await orgEndingIn(13 * DAY, BLR, "due")
    edge = await orgEndingIn(14 * DAY, BLR, "edge")
    later = await orgEndingIn(15 * DAY, BLR, "later")
    granted = await orgEndingIn(13 * DAY, BLR, "granted")
    ended = await orgEndingIn(-1 * DAY, BLR, "ended")
    canada = await orgEndingIn(13 * DAY, [{ city: "Toronto" }], "canada")
    suspended = await orgEndingIn(13 * DAY, BLR, "suspended", "suspended")
    uncatalogued = await orgEndingIn(13 * DAY, [{ city: "Bengaluru" }, { city: "Toronto Downtown" }], "uncat")
    deletedToronto = await orgEndingIn(13 * DAY, [{ city: "Toronto", deleted: true }, { city: "Bengaluru" }], "deltor")
    torontoDraft = await orgEndingIn(13 * DAY, [{ city: "Toronto", status: "draft" }, { city: "Bengaluru" }], "tordraft")
    await db.$transaction((tx) => grantEntitlement(tx, { subject: { kind: "org", id: granted.id }, product: "analytics", months: 6, now }))
    mockSendEmail.mockResolvedValue(sent)
    count = await sendFreeWindowEndingMail(now)
    first = [...mockSendEmail.mock.calls]
  })

  it("mails an organisation 13 days from its end: the owner and the live admin, not the staff member or a deleted admin", () => {
    expect(mailedFor(due, first)).toEqual([due.owner, due.admin].sort())
  })

  it("marks it with the pass's own clock", async () => {
    expect(await markOf(due.id)).toEqual(now)
  })

  it("mails one exactly 14 days out", async () => {
    expect(mailedFor(edge, first)).toEqual([edge.owner, edge.admin].sort())
    expect(await markOf(edge.id)).toEqual(now)
  })

  it("counts the organisations it mailed (these two, an uncatalogued city's and a deleted Toronto night's, and any other due row)", () => {
    expect(count).toBeGreaterThanOrEqual(4)
  })

  it("names the date, the prices and the Plan page, with nothing unfilled", () => {
    const mail = first.find(([m]) => (m as { to: string }).to === due.owner)?.[0] as {
      subject: string
      text: string
      html: string
    }
    expect(mail.text).toContain("₹589")
    expect(mail.text).toContain("₹2,359")
    expect(mail.text).toContain("/dashboard/plan")
    expect(`${mail.subject}\n${mail.text}`).not.toMatch(/undefined|\bnull\b|NaN|<[a-z_]+>/i)
    expect(mail.html).not.toMatch(/undefined|\bnull\b|NaN/)
  })

  it("mails nobody 15 days out, with a grant, already past its end, in Canada, or suspended", async () => {
    for (const org of [later, granted, ended, canada, suspended]) {
      expect(mailedFor(org, first)).toEqual([])
      expect(await markOf(org.id)).toBeNull()
    }
  })

  it("reads markets through the catalogue: an uncatalogued city and a deleted Toronto night say nothing, a Toronto draft says Canada", async () => {
    expect(mailedFor(uncatalogued, first)).toEqual([uncatalogued.owner, uncatalogued.admin].sort())
    expect(mailedFor(deletedToronto, first)).toEqual([deletedToronto.owner, deletedToronto.admin].sort())
    expect(mailedFor(torontoDraft, first)).toEqual([])
    expect(await markOf(torontoDraft.id)).toBeNull()
  })

  it("sends nothing on a second pass", async () => {
    mockSendEmail.mockClear()
    expect(await sendFreeWindowEndingMail(new Date(now.getTime() + 5 * 60_000))).toBe(0)
    for (const org of [due, edge, uncatalogued, deletedToronto]) expect(mailedFor(org)).toEqual([])
  })
})

describe("two passes at once (two replicas)", () => {
  it("mail each recipient once", async () => {
    const raced = await orgEndingIn(12 * DAY, BLR, "raced")
    await Promise.all([sendFreeWindowEndingMail(now), sendFreeWindowEndingMail(now)])
    expect(mailedFor(raced)).toEqual([raced.owner, raced.admin].sort())
  })
})

describe("a send that fails after the claim", () => {
  it("keeps the claim, says which organisation lost its mail, and is never sent again", async () => {
    const failing = await orgEndingIn(10 * DAY, BLR, "failing")
    const warn = jest.spyOn(logger, "warn")
    mockSendEmail.mockResolvedValue({ sent: false, reason: "provider_error", detail: "HTTP 500" })
    await sendFreeWindowEndingMail(now)
    expect(mailedFor(failing)).toEqual([failing.owner, failing.admin].sort())
    expect(await markOf(failing.id)).toEqual(now)
    expect(warn).toHaveBeenCalledWith("Free-window ending mail lost for this window", {
      orgId: failing.id,
      recipients: 2,
      unsent: 2,
      reasons: ["HTTP 500"],
    })

    mockSendEmail.mockReset()
    mockSendEmail.mockResolvedValue(sent)
    await sendFreeWindowEndingMail(new Date(now.getTime() + 5 * 60_000))
    expect(mailedFor(failing)).toEqual([])
  })

  it("a send that throws loses that organisation's mail only: the next one in the batch is still mailed", async () => {
    const throwing = await orgEndingIn(2 * DAY, BLR, "throws")
    const next = await orgEndingIn(3 * DAY, BLR, "next")
    const warn = jest.spyOn(logger, "warn")
    mockSendEmail.mockImplementation(async (m: { to: string }) => {
      if (m.to === throwing.owner || m.to === throwing.admin) throw new Error("socket hang up")
      return sent
    })
    await sendFreeWindowEndingMail(now)
    expect(await markOf(throwing.id)).toEqual(now)
    expect(warn).toHaveBeenCalledWith("Free-window ending mail lost for this window", { orgId: throwing.id, error: "socket hang up" })
    expect(mailedFor(next)).toEqual([next.owner, next.admin].sort())
  })
})
