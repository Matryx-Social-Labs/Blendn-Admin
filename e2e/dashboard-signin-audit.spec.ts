import { test, expect, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { ROLE_ACCOUNTS } from "./fixtures/auth"

/**
 * Every dashboard sign-in leaves an audit row: who, and from which address
 * (SCRUM-1238, launch gate 10). Driven through the real form as the seeded
 * admin and organizer, with the rows read back.
 *
 * The browser sends its own `x-real-ip` from a documentation range. Against a
 * local server (CI) there is no edge to overwrite it, so it is the address the
 * sign-in limiter keys on and the one the row must carry, and it keeps this file's three
 * attempts out of the five `sign-in.spec.ts` spends from the runner's address.
 *
 * The 12-hour end of an admin's session is pinned by
 * `__tests__/session-revocation.test.ts`; a real 12-hour wait is not a drive.
 */
const PASSWORD = process.env.SEED_PASSWORD
// The rows are this run's by their address alone: no time filter, which would compare this clock with the database's.
const IP = `203.0.113.${1 + Math.floor(Math.random() * 254)}`
const NO_MATCH = "That email and password don't match an operator account."

test.use({ extraHTTPHeaders: { "x-real-ip": IP } })

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const where = { action: "auth.dashboard_signin", ip_address: IP }

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("SEED_PASSWORD is required: it is the password the seeded accounts sign in with.")
})

test.afterAll(async () => {
  await db.audit_logs.deleteMany({ where })
  await db.$disconnect()
})

async function submit(page: Page, email: string, password: string) {
  await page.goto("/login")
  await page.locator("#email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

const idOf = async (email: string) => (await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id

/** The rows this run wrote for one account. The write is not awaited by the sign-in, so callers poll. */
const rowsFor = (userId: string) =>
  db.audit_logs.findMany({
    where: { ...where, user_id: userId },
    select: { user_id: true, action: true, resource: true, resource_id: true, ip_address: true, details: true, org_id: true },
  })

const expected = (userId: string) => ({
  user_id: userId,
  action: "auth.dashboard_signin",
  resource: "user",
  resource_id: userId,
  ip_address: IP,
  details: { provider: "credentials" },
  org_id: null,
})

/** Polls for the one row, then reads again after a pause, so a second row written late fails too. The read-back goes to the CI log. */
async function exactlyOneRow(page: Page, userId: string) {
  await expect.poll(() => rowsFor(userId)).toEqual([expected(userId)])
  await page.waitForTimeout(1_000)
  const rows = await rowsFor(userId)
  console.log(`read back for ${userId}: ${JSON.stringify(rows)}`)
  expect(rows).toEqual([expected(userId)])
}

test("the admin's sign-in leaves one row with the address it came from", async ({ page }) => {
  const admin = await idOf(ROLE_ACCOUNTS.admin.email)
  await submit(page, ROLE_ACCOUNTS.admin.email, PASSWORD!)
  await expect(page).toHaveURL(/\/dashboard/)

  await exactlyOneRow(page, admin)
})

test("the organizer's wrong password leaves no row; the right one after it leaves exactly one", async ({ page }) => {
  const organizer = await idOf(ROLE_ACCOUNTS.organizer.email)
  await submit(page, ROLE_ACCOUNTS.organizer.email, "not-the-password-0")
  await expect(page.locator("#signin-error")).toContainText(NO_MATCH)
  expect(await rowsFor(organizer)).toEqual([])

  await submit(page, ROLE_ACCOUNTS.organizer.email, PASSWORD!)
  await expect(page).toHaveURL(/\/dashboard/)
  await exactlyOneRow(page, organizer)
})
