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

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

const DAY = 24 * 60 * 60 * 1000
const now = new Date()
const users: string[] = []
const events: string[] = []
const orgs: string[] = []

async function orgEndingIn(days: number, city: string, label: string) {
  const owner = await makeUser(testId(`fw-${label}-owner`), "organizer")
  const admin = await makeUser(testId(`fw-${label}-admin`), "organizer")
  const staff = await makeUser(testId(`fw-${label}-staff`), "organizer")
  users.push(owner, admin, staff)
  const org = await db.organisations.create({
    data: {
      kind: "company",
      display_name: testId(`fw-${label}`),
      status: "verified",
      analytics_free_until: new Date(now.getTime() + days * DAY),
    },
  })
  orgs.push(org.id)
  for (const [user_id, role] of [[owner, "owner"], [admin, "admin"], [staff, "staff"]] as const) {
    await db.organisation_members.create({ data: { org_id: org.id, user_id, role } })
  }
  const start = new Date(now.getTime() - 80 * DAY)
  const e = await db.events.create({
    data: {
      slug: testId(`fw-${label}-night`),
      title: `Free window ${label}`,
      description: "fixture",
      start_time: start,
      end_time: new Date(start.getTime() + 3 * 60 * 60 * 1000),
      timezone: "Asia/Kolkata",
      city,
      status: "completed",
      organizer_id: owner,
      organizer_org_id: org.id,
    },
  })
  events.push(e.id)
  await db.organisations.update({ where: { id: org.id }, data: { first_free_event_id: e.id } })
  const email = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } })).email
  return { id: org.id, owner: await email(owner), admin: await email(admin), staff: await email(staff) }
}

const mailedFor = (org: { owner: string; admin: string; staff: string }) =>
  mockSendEmail.mock.calls.map(([m]) => (m as { to: string }).to).filter((to) => [org.owner, org.admin, org.staff].includes(to))

const markOf = async (orgId: string) =>
  (await db.organisations.findUniqueOrThrow({ where: { id: orgId }, select: { analytics_free_ending_mailed_at: true } }))
    .analytics_free_ending_mailed_at

let due: Awaited<ReturnType<typeof orgEndingIn>>
let later: Awaited<ReturnType<typeof orgEndingIn>>
let granted: Awaited<ReturnType<typeof orgEndingIn>>
let ended: Awaited<ReturnType<typeof orgEndingIn>>
let canada: Awaited<ReturnType<typeof orgEndingIn>>

beforeAll(async () => {
  mockSendEmail.mockResolvedValue({ sent: true, id: "re_test" })
  due = await orgEndingIn(13, "Bengaluru", "due")
  later = await orgEndingIn(15, "Bengaluru", "later")
  granted = await orgEndingIn(13, "Bengaluru", "granted")
  ended = await orgEndingIn(-1, "Bengaluru", "ended")
  canada = await orgEndingIn(13, "Toronto", "canada")
  await db.$transaction((tx) => grantEntitlement(tx, { subject: { kind: "org", id: granted.id }, product: "analytics", months: 6, now }))
})

afterAll(async () => {
  await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await appDb.$disconnect()
  await closeDb()
})

describe("the first pass", () => {
  beforeAll(async () => {
    mockSendEmail.mockClear()
    await sendFreeWindowEndingMail(now)
  })

  it("mails an organisation 13 days from its end: the owner and the admin, not the staff member", () => {
    expect(mailedFor(due).sort()).toEqual([due.owner, due.admin].sort())
  })

  it("marks that organisation as mailed", async () => {
    expect(await markOf(due.id)).toEqual(now)
  })

  it("names the date, the prices and the Plan page, with nothing unfilled", () => {
    const mail = mockSendEmail.mock.calls.find(([m]) => (m as { to: string }).to === due.owner)?.[0] as {
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

  it("mails nobody at an organisation 15 days out, one with a grant, one already past its end, or one in Canada", async () => {
    for (const org of [later, granted, ended, canada]) {
      expect(mailedFor(org)).toEqual([])
      expect(await markOf(org.id)).toBeNull()
    }
  })
})

describe("a second pass", () => {
  it("sends nothing to the organisation already mailed", async () => {
    mockSendEmail.mockClear()
    await sendFreeWindowEndingMail(new Date(now.getTime() + 5 * 60_000))
    expect(mailedFor(due)).toEqual([])
    expect(await markOf(due.id)).toEqual(now)
  })
})

describe("a send that fails after the claim", () => {
  it("keeps the claim: the mail is lost for that window, never sent twice", async () => {
    const failing = await orgEndingIn(10, "Bengaluru", "failing")
    mockSendEmail.mockClear()
    mockSendEmail.mockResolvedValue({ sent: false, reason: "provider_error", detail: "HTTP 500" })
    await sendFreeWindowEndingMail(now)
    expect(mailedFor(failing).length).toBeGreaterThan(0)
    expect(await markOf(failing.id)).toEqual(now)

    mockSendEmail.mockClear()
    mockSendEmail.mockResolvedValue({ sent: true })
    await sendFreeWindowEndingMail(new Date(now.getTime() + 5 * 60_000))
    expect(mailedFor(failing)).toEqual([])
  })
})
