import { test, expect, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"
import { randomBytes } from "node:crypto"

import { visibleNavFor } from "../lib/dashboard-nav"
import { hashInviteToken } from "../lib/org-invites"
import { ROLE_ACCOUNTS } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * Dashboard entry comes from the membership, not `User.role` (SCRUM-1247).
 *
 * An attendee-role account is invited to organizer@'s organisation, signs in at the dashboard through the real form
 * (a live invite lets them) and accepts. With its row put back to `attendee`, it signs in again and Events opens: the
 * membership alone. With the membership removed, the same sign-in is refused. The control, an attendee with no
 * membership and no invite, gets the app-only refusal at /login. Then the seeded organizer@ (an owner of that org, the pilot hosts' shape)
 * still reaches every page of its sidebar, with the session's role claim `organizer`.
 *
 * The real form, not a minted cookie: `authorize` is half of what changed. Its own `x-real-ip` from a documentation
 * range keeps this file's four sign-ins out of the limits other specs spend. Every row is created here and removed by
 * id; the seed is untouched.
 */
const IP = `198.51.100.${1 + Math.floor(Math.random() * 254)}`
test.use({ extraHTTPHeaders: { "x-real-ip": IP } })

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const stamp = Date.now()
const PASSWORD = `Entry-${randomBytes(9).toString("base64url")}-42`
const APP_ONLY = "This account is for the Blend'n app."
const made = { users: [] as string[], invites: [] as string[] }

test.afterAll(async () => {
  await db.organisation_invites.deleteMany({ where: { id: { in: made.invites } } })
  await db.organisation_members.deleteMany({ where: { user_id: { in: made.users } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: made.users } } })
  await db.user.deleteMany({ where: { id: { in: made.users } } })
  await db.$disconnect()
})

async function attendee(label: string) {
  const email = `e2e.entry.${label}.${stamp}@blendn.app`
  const { id } = await db.user.create({
    data: { email, name: `Entry ${label}`, role: "attendee", password: await bcrypt.hash(PASSWORD, 4), emailVerified: new Date() },
    select: { id: true },
  })
  made.users.push(id)
  return { id, email }
}

async function signIn(page: Page, email: string) {
  await page.locator("#email").fill(email)
  await page.locator("#password").fill(PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
}

/** What the session says about this browser's person: the claim the middleware, the nav and every page read. */
const claim = async (page: Page) => (await (await page.request.get("/api/auth/session")).json())?.user

test("an attendee who accepts an organizer org's invite enters the dashboard; one with no membership is refused", async ({ page }) => {
  test.setTimeout(120_000)
  const organizer = await db.user.findUniqueOrThrow({ where: { email: ROLE_ACCOUNTS.organizer.email }, select: { id: true } })
  const home = await db.organisation_members.findFirstOrThrow({
    where: { user_id: organizer.id, role: "owner", org: { status: { not: "suspended" } } },
    orderBy: [{ created_at: "asc" }, { org_id: "asc" }],
    select: { org_id: true, org: { select: { display_name: true } } },
  })

  // The control first: an attendee with no membership and no invite is refused at the form, by name.
  const stranger = await attendee("none")
  await page.goto("/login")
  await signIn(page, stranger.email)
  await expect(page.locator("#signin-error")).toContainText(APP_ONLY)
  await expect(page).toHaveURL(/\/login/)
  expect(await db.organisation_members.findMany({ where: { user_id: stranger.id } })).toEqual([])

  // The invited attendee. No grants_role: nothing reads it now.
  const invited = await attendee("invited")
  const token = randomBytes(32).toString("base64url")
  const invite = await db.organisation_invites.create({
    data: { org_id: home.org_id, email: invited.email, role: "staff", token_hash: hashInviteToken(token), expires_at: new Date(Date.now() + 86_400_000), invited_by: organizer.id },
    select: { id: true },
  })
  made.invites.push(invite.id)

  await page.context().clearCookies()
  await page.goto(`/invite?token=${encodeURIComponent(token)}`)
  await page.getByRole("link", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/login\?callbackUrl=/)
  await signIn(page, invited.email)
  await expect(page.getByRole("heading", { name: "You're in" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(home.org.display_name).first()).toBeVisible()

  // Read back: the membership is what grants entry; the row's role is still promoted until task 11 stops the write.
  const memberships = await db.organisation_members.findMany({ where: { user_id: invited.id }, select: { org_id: true, role: true } })
  const row = await db.user.findUniqueOrThrow({ where: { id: invited.id }, select: { role: true } })
  console.log(`read back for ${invited.id}: organisation_members=${JSON.stringify(memberships)} "User".role=${row.role}`)
  expect(memberships).toEqual([{ org_id: home.org_id, role: "staff" }])
  expect(row.role).toBe("organizer")

  // The page says to sign in again: the cookie from the invite's sign-in carries no dashboard (today's behaviour).
  await expect(page.getByText("Sign out and back in to pick up your new access.")).toBeVisible()

  // The membership alone: the row goes back to attendee (as task 11 will leave it), and the next sign-in still enters.
  await db.user.update({ where: { id: invited.id }, data: { role: "attendee" } })
  await page.context().clearCookies()
  await page.goto(`/login?callbackUrl=${encodeURIComponent("/dashboard/events")}`)
  await signIn(page, invited.email)
  await expect(page).toHaveURL(/\/dashboard\/events$/, { timeout: 30_000 })
  await expect(page.locator("main h1")).toHaveCount(1)
  await expect(page).toHaveTitle(/^Events/)
  expect(await claim(page)).toMatchObject({ id: invited.id, role: "organizer", inviteOnly: false })

  // And without it: the same account, the membership gone, is refused at the form like any attendee.
  await db.organisation_members.deleteMany({ where: { user_id: invited.id } })
  await page.context().clearCookies()
  await page.goto("/login")
  await signIn(page, invited.email)
  await expect(page.locator("#signin-error")).toContainText(APP_ONLY)
})

test("the seeded organizer@, an org owner, still reaches every page of its sidebar", async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext({ baseURL, storageState: statePathFor("organizer") })
  const page = await context.newPage()
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" })
  expect(await claim(page)).toMatchObject({ role: "organizer", inviteOnly: false })

  const urls = visibleNavFor("organizer").map((i) => i.url)
  expect(urls.length).toBeGreaterThan(3)
  // The sidebar it draws holds every one of them.
  const drawn = await page.locator("nav[aria-label='Dashboard'] a[href^='/dashboard']").evaluateAll((as) => as.map((a) => a.getAttribute("href")))
  for (const url of urls) expect(drawn, `${url} is in the sidebar`).toContain(url)
  for (const url of urls) {
    await page.goto(url, { waitUntil: "domcontentloaded" })
    expect(new URL(page.url()).pathname, `${url} opens`).toBe(url)
    await expect(page.locator("main h1"), `${url} draws its page`).toHaveCount(1)
  }
  await context.close()
})
