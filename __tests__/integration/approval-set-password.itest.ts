import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"
import type { DashboardRole } from "@/lib/dashboard-types"

/*
 * Approving a host hands them a link to set their own password, never the
 * password itself (SCRUM-134). Real action, real rows, then the link consumed
 * through the real reset route and the new password checked against the hash.
 */
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/rate-limit", () => ({ rateLimit: jest.fn().mockResolvedValue(null) }))

const sent: { to: string; text: string; html: string }[] = []
jest.mock("@/lib/email", () => {
  const actual = jest.requireActual("@/lib/email")
  return {
    ...actual,
    emailConfigured: () => true,
    sendEmail: jest.fn(async (m: { to: string; text: string; html: string }) => {
      sent.push(m)
      return { sent: true, id: "fake" }
    }),
  }
})

import { approveOnboardingRequest } from "@/lib/onboarding-actions"
import { POST as resetPassword } from "@/app/api/auth/reset-password/route"
import { db, closeDb, makeUser, testId } from "./helpers"

const users: string[] = []
const requests: string[] = []
const orgs: string[] = []

afterAll(async () => {
  await db.organiser_onboarding_requests.deleteMany({ where: { id: { in: requests } } })
  await db.organisation_domains.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.audit_logs.deleteMany({ where: { resource_id: { in: [...requests, ...users] } } })
  await db.password_reset_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function application(email: string) {
  const r = await db.organiser_onboarding_requests.create({
    data: {
      kind: "company",
      display_name: testId("org"),
      contact_name: "New Host",
      contact_email: email,
      tier: "needs_proof",
      status: "pending",
      email_verified_at: new Date(),
      requested_role: "organizer",
    },
    select: { id: true },
  })
  requests.push(r.id)
  return r.id
}

beforeAll(async () => {
  const adminId = await makeUser(testId("asp-admin"), "app_admin")
  users.push(adminId)
  session = { user: { id: adminId, role: "app_admin" } }
})

it("emails a single-use set-password link and no password; the link sets the password once", async () => {
  const email = `${testId("host")}@example.test`
  const result = await approveOnboardingRequest(await application(email))
  orgs.push(result.orgId)
  const user = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true, password: true } })
  users.push(user.id)

  // The mail: a link, never a password.
  expect(result.emailSent).toBe(true)
  expect(result.setPasswordLink).toBe("") // it went out; the admin is not shown it
  const mail = sent.find((m) => m.to === email)!
  expect(mail.text).not.toMatch(/^Password:/m)
  const link = mail.text.match(/https?:\/\/\S+\/reset-password\?token=\S+/)![0]
  expect(mail.html).toContain(`href="${link}"`)

  // One live token, a day long.
  const tokens = await db.password_reset_tokens.findMany({ where: { user_id: user.id } })
  expect(tokens).toHaveLength(1)
  expect(tokens[0].used_at).toBeNull()
  expect(tokens[0].expires_at.getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000)

  // The password nobody was told is not something anybody could guess from the mail.
  expect(user.password).toMatch(/^\$2[aby]\$/)

  // The link works — once.
  const token = new URL(link).searchParams.get("token")!
  const post = (password: string) =>
    resetPassword(
      new NextRequest("http://localhost/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
    )
  expect((await post("Correct-horse-9-battery")).status).toBe(200)
  const after = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { password: true } })
  expect(await bcrypt.compare("Correct-horse-9-battery", after.password!)).toBe(true)
  expect((await post("Another-horse-9-battery")).status).toBe(400)
})

it("a promoted attendee keeps their password and gets no link", async () => {
  const email = `${testId("promoted")}@example.test`
  const id = await makeUser(testId("asp-att"), "attendee")
  users.push(id)
  const hashed = await bcrypt.hash("Their-own-password-1", 4)
  await db.user.update({ where: { id }, data: { email, password: hashed } })

  const result = await approveOnboardingRequest(await application(email))
  orgs.push(result.orgId)

  expect(result.setPasswordLink).toBe("")
  expect(await db.password_reset_tokens.count({ where: { user_id: id } })).toBe(0)
  expect((await db.user.findUniqueOrThrow({ where: { id } })).password).toBe(hashed)
  expect(sent.find((m) => m.to === email)!.text).toMatch(/existing password/i)
})

it("with email unconfigured the admin is handed the link, once", async () => {
  const emailMod = jest.requireMock("@/lib/email") as { emailConfigured: () => boolean }
  const was = emailMod.emailConfigured
  emailMod.emailConfigured = () => false
  try {
    const email = `${testId("offline")}@example.test`
    const result = await approveOnboardingRequest(await application(email))
    orgs.push(result.orgId)
    users.push((await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id)
    expect(result.emailSent).toBe(false)
    expect(result.setPasswordLink).toMatch(/\/reset-password\?token=/)
    expect(sent.some((m) => m.to === email)).toBe(false)
  } finally {
    emailMod.emailConfigured = was
  }
})
