import { test, expect, chromium, type Browser } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"

/**
 * SCRUM-1269 driven: the free window is 90 days from the first night with 8
 * people checked in. An organisation with a night of 6 (50 days ago) and a
 * night of 8 (40 days ago) opens /dashboard/plan; the page writes the window
 * once, and the row is read back: the 8-person night and its end + 90 days,
 * the same date the page shows. /pricing and /apply say the rule, at 1280
 * and 768, with nothing wider than the viewport. Run in CI because the host
 * that wrote it was over the load limit for a local dev server.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const DAY = 24 * 60 * 60 * 1000
const tag = `e2e-free-window-${randomUUID().slice(0, 8)}`
const PLAN_DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
const WIDTHS = [1280, 768] as const

const users: string[] = []
const events: string[] = []
let orgId = ""
let owner = ""
let six = { id: "", end: new Date(0) }
let eight = { id: "", end: new Date(0) }
let browser: Browser

async function person(label: string, role: "attendee" | "organizer" = "attendee") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u.id
}

async function night(label: string, endedDaysAgo: number, guests: string[]) {
  const end = new Date(Date.now() - endedDaysAgo * DAY)
  const start = new Date(end.getTime() - 4 * 60 * 60 * 1000)
  const e = await db.events.create({
    data: {
      slug: `${tag}-${label}`,
      title: `${tag} ${label}`,
      description: "e2e fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
      organizer_org_id: orgId,
    },
  })
  events.push(e.id)
  const occ = await db.event_occurrences.create({
    data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  for (const user_id of guests) {
    await db.event_check_ins.create({
      data: { event_id: e.id, occurrence_id: occ.id, user_id, status: "checked_out", check_in_time: start, check_out_time: end },
    })
  }
  return { id: e.id, end }
}

async function sessionFor(baseURL: string) {
  const { hostname, protocol } = new URL(baseURL)
  const token = await encode({ token: { sub: owner, role: "organizer" }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })
  return {
    cookies: [
      {
        name: protocol === "https:" ? "__Secure-next-auth.session-token" : "next-auth.session-token",
        value: token,
        domain: hostname,
        path: "/",
        httpOnly: true,
        secure: protocol === "https:",
        sameSite: "Lax" as const,
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ],
    origins: [],
  }
}

test.beforeAll(async () => {
  browser = await chromium.launch()
  owner = await person("owner", "organizer")
  orgId = (await db.organisations.create({ data: { kind: "company", display_name: `${tag} org`, status: "verified" } })).id
  await db.organisation_members.create({ data: { org_id: orgId, user_id: owner, role: "owner" } })
  const guests: string[] = []
  for (let i = 0; i < 8; i++) guests.push(await person(`guest${i}`))
  six = await night("six", 50, guests.slice(0, 6))
  eight = await night("eight", 40, guests)
})

test.afterAll(async () => {
  await browser.close()
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisation_members.deleteMany({ where: { org_id: orgId } })
  await db.organisations.deleteMany({ where: { id: orgId } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

/** Nothing on the page is wider than the viewport. */
async function overflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test("the Plan page starts the window at the night of 8, not 6, and the row says the same", async ({ baseURL }) => {
  const until = new Date(eight.end.getTime() + 90 * DAY)
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 }, storageState: await sessionFor(baseURL!) })
    const page = await ctx.newPage()
    await page.goto("/dashboard/plan")
    // Visible only: React's streamed copy of the panel can sit in a hidden div until it is swapped in (CI run 45743334742).
    await expect(page.getByText(`Free · Analytics open until ${PLAN_DAY.format(until)}`).filter({ visible: true })).toBeVisible()
    await expect(page.getByText("opened every Analytics view for 90 days", { exact: false }).filter({ visible: true })).toBeVisible()
    await expect(page.getByText("Payments are taken by Razorpay for Matryx Social Labs Private Limited").filter({ visible: true })).toBeVisible()
    await expect(page.getByText(/invoice/i)).toHaveCount(0)
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await ctx.close()
  }

  const row = await db.organisations.findUniqueOrThrow({
    where: { id: orgId },
    select: { analytics_free_until: true, first_free_event_id: true },
  })
  // The read-back, in the CI log: SELECT analytics_free_until, first_free_event_id FROM organisations WHERE id = <org>.
  console.log(`READBACK ${JSON.stringify({ org: orgId, ...row, six: six.id, eight: eight.id, eightEnded: eight.end })}`)
  expect(row).toEqual({ analytics_free_until: until, first_free_event_id: eight.id })
})

test("/pricing and /apply state three months from the first night of 8, and no invoice", async ({ baseURL }) => {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 } })
    const page = await ctx.newPage()
    await page.goto("/pricing")
    await expect(page.getByText("Analytics is free for a new organisation for 90 days from its first event with at least 8 people checked in", { exact: false })).toBeVisible()
    await expect(page.getByText(/invoice/i)).toHaveCount(0)
    expect(await overflow(page), `pricing overflow at ${width}`).toBeLessThanOrEqual(0)
    await page.goto("/apply")
    await expect(page.getByText("Analytics is free for your first three months of events, then an optional paid plan.")).toBeVisible()
    expect(await overflow(page), `apply overflow at ${width}`).toBeLessThanOrEqual(0)
    await ctx.close()
  }
})
