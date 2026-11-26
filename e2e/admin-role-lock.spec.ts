import { test, expect, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { ROLE_ACCOUNTS } from "./fixtures/auth"

/**
 * The admin role is locked to the company domain (SCRUM-1235) and a promotion
 * needs a second admin (SCRUM-1240), launch gate 10.
 *
 * Driven on Users: making a gmail attendee an admin is refused and the toast
 * says why. A verified company address is requested by one admin, re-requested
 * by the same admin (still waiting), and confirmed by a second, each through
 * its own fresh sign-in. The row and its audit rows are read back after every
 * step, and printed to the CI log.
 */
const PASSWORD = process.env.SEED_PASSWORD
// Admin B: a product owner's admin account, seeded by seed:qa with the same password.
const SECOND_ADMIN = "likhith.gowda@blendn.app"
// TEST-NET-2, so this file's sign-ins key the limiter and their audit rows apart from every other spec's.
const IP = `198.51.100.${1 + Math.floor(Math.random() * 254)}`
const WAITING = "Waiting for a second admin to confirm within 24 hours"

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const tag = `rolelock${Date.now().toString(36)}`
const ids: string[] = []

test.afterAll(async () => {
  if (ids.length) {
    await db.audit_logs.deleteMany({ where: { resource_id: { in: ids } } })
    await db.profiles.deleteMany({ where: { id: { in: ids } } })
    await db.user.deleteMany({ where: { id: { in: ids } } })
  }
  await db.audit_logs.deleteMany({ where: { action: "auth.dashboard_signin", ip_address: IP } })
  await db.$disconnect()
})

async function attendee(email: string) {
  const { id } = await db.user.create({ data: { email, name: `${tag} ${email.split("@")[1]}`, role: "attendee", emailVerified: new Date() } })
  ids.push(id)
  return id
}

async function makeAdmin(page: Page, email: string) {
  await page.goto(`/dashboard/users?search=${encodeURIComponent(email)}`)
  await page.getByRole("row", { name: new RegExp(email) }).getByRole("button", { name: "Open menu" }).click()
  await page.getByRole("menuitem", { name: "Edit" }).click()
  await page.getByLabel("Role").click()
  await page.getByRole("option", { name: "App Admin" }).click()
  await page.getByRole("button", { name: "Save Changes" }).click()
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies()
  await page.goto("/login")
  await page.locator("#email").fill(email)
  await page.locator("#password").fill(PASSWORD!)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/dashboard/)
}

const idOf = async (email: string) => (await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id

/** The equivalent of SELECT role, admin_requested_by, admin_requested_at FROM "User", plus its promotion audit rows. */
async function readBack(id: string, step: string) {
  const row = await db.user.findUniqueOrThrow({ where: { id }, select: { role: true, admin_requested_by: true, admin_requested_at: true } })
  const audit = await db.audit_logs.findMany({
    // The sheet saves the profile first, which may add a user.updated row: not what this spec is about.
    where: { resource_id: id, action: { in: ["user.admin_promotion_requested", "user.role_changed"] } },
    select: { action: true, user_id: true, details: true },
    orderBy: { created_at: "asc" },
  })
  console.log(`read back (${step}) for ${id}: ${JSON.stringify({ ...row, audit })}`)
  return { ...row, audit }
}

test.describe("refused off the company domain", () => {
  test.use({ storageState: "e2e/.auth/admin.json" })

  test("a gmail attendee cannot be made an admin", async ({ page }) => {
    const gmail = `${tag}@gmail.com`
    const gmailId = await attendee(gmail)

    await makeAdmin(page, gmail)
    await expect(
      page.getByText(
        "Only a verified @matrixsociallabs.com account can be an admin. Set up the person's company account and make that one an admin."
      )
    ).toBeVisible()
    expect(await readBack(gmailId, "gmail refused")).toEqual({ role: "attendee", admin_requested_by: null, admin_requested_at: null, audit: [] })
  })
})

test.describe("a second admin confirms", () => {
  test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { "x-real-ip": IP } })

  test.beforeAll(() => {
    if (!PASSWORD) throw new Error("SEED_PASSWORD is required: it is the password the seeded admins sign in with.")
  })

  test("A asks, A asking again still waits, B confirms", async ({ page }) => {
    const company = `${tag}@matrixsociallabs.com`
    const id = await attendee(company)
    const a = await idOf(ROLE_ACCOUNTS.admin.email)
    const b = await idOf(SECOND_ADMIN)
    const requested = { action: "user.admin_promotion_requested", user_id: a, details: { to: "app_admin" } }

    await signIn(page, ROLE_ACCOUNTS.admin.email)
    await makeAdmin(page, company)
    await expect(page.getByText(WAITING)).toBeVisible()
    const first = await readBack(id, "A asked")
    expect(first).toMatchObject({ role: "attendee", admin_requested_by: a, audit: [requested] })
    expect(first.admin_requested_at).not.toBeNull()

    await makeAdmin(page, company)
    await expect(page.getByText(WAITING)).toBeVisible()
    expect(await readBack(id, "A asked again")).toMatchObject({ role: "attendee", admin_requested_by: a, audit: [requested, requested] })

    await signIn(page, SECOND_ADMIN)
    await makeAdmin(page, company)
    await expect(page.getByText("User updated successfully")).toBeVisible()
    expect(await readBack(id, "B confirmed")).toEqual({
      role: "app_admin",
      admin_requested_by: null,
      admin_requested_at: null,
      audit: [
        requested,
        requested,
        { action: "user.role_changed", user_id: b, details: { from: "attendee", to: "app_admin", requestedBy: a, approvedBy: b } },
      ],
    })
  })
})
