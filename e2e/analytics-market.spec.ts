import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"

/**
 * SCRUM-1277 driven: where plans are not sold, Analytics stays open. An
 * organisation whose nights are in Toronto (a CA city in the catalogue's
 * migration rows) and whose free window ended 30 days ago opens
 * /dashboard/analytics at 1280 and 768: its own figures (the canary night's
 * median stay, 2h 53m), "Free while we launch in your city." in the access
 * line, nothing wider than the viewport, and no price, no See plans, no date,
 * the sidebar's "Free plan" card included.
 * Moved to Bengaluru, the same page is locked at once from the stored date.
 *
 * The task's read-back, printed before and after both reads: the window row,
 * which neither read may change.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const tag = `e2e-analytics-market-${randomUUID().slice(0, 8)}`
const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000
const WIDTHS = [1280, 768] as const
const LINE = "Free while we launch in your city."
const STAY = "2h 53m"
const NOTHING_TO_BUY = /₹|See plans|Open until|\(locked\)|upgrade/i
const SCREENS = "test-results/screens"

const users: string[] = []
const events: string[] = []
let organizer = ""
let orgId = ""
let canary = ""
let browser: Browser

async function person(label: string, role: "attendee" | "organizer" = "attendee") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u.id
}

/** A Toronto night of the organisation's that started `daysAgo` days ago, everyone staying `minutes`. */
async function night(label: string, daysAgo: number, attendees: string[], minutes: number) {
  const start = new Date(Date.now() - daysAgo * DAY)
  const end = new Date(start.getTime() + 4 * 60 * MIN)
  const e = await db.events.create({
    data: {
      slug: `${tag}-${label}`,
      title: `${tag} ${label}`,
      description: "e2e fixture",
      start_time: start,
      end_time: end,
      timezone: "America/Toronto",
      status: "published",
      city: "Toronto",
      organizer_id: organizer,
      organizer_org_id: orgId,
    },
  })
  events.push(e.id)
  const occ = await db.event_occurrences.create({
    data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  for (const user_id of attendees) {
    const left = new Date(start.getTime() + minutes * MIN)
    await db.event_check_ins.create({
      data: { event_id: e.id, occurrence_id: occ.id, user_id, status: "checked_out", check_in_time: start, check_out_time: left },
    })
    await db.presence_sessions.create({
      data: { event_id: e.id, occurrence_id: occ.id, user_id, arrived_at: start, departed_at: left, departed_source: "user" },
    })
  }
  return { id: e.id, end }
}

async function sessionFor(baseURL: string, sub: string) {
  const { hostname, protocol } = new URL(baseURL)
  const token = await encode({ token: { sub, role: "organizer" }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })
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
  mkdirSync(SCREENS, { recursive: true })
  organizer = await person("organizer", "organizer")
  const org = await db.organisations.create({
    data: { kind: "company", display_name: `${tag} The Queen Street West Late-Night Creative Collective and Friends`, status: "verified" },
  })
  orgId = org.id
  await db.organisation_members.create({ data: { org_id: orgId, user_id: organizer, role: "owner" } })
  const crowd: string[] = []
  for (let i = 0; i < 8; i++) crowd.push(await person(`p${i}`))
  // The first night of eight, 120 days ago: its 90 free days ended 30 days ago, written as a past visit would have.
  const first = await night("First Thursday on Queen West", 120, crowd, 95)
  canary = (await night("Sunday Soul on Ossington", 10, crowd, 173)).id
  await db.organisations.update({
    where: { id: orgId },
    data: { analytics_free_until: new Date(first.end.getTime() + 90 * DAY), first_free_event_id: first.id },
  })
})

test.afterAll(async () => {
  await browser.close()
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.organisations.update({ where: { id: orgId }, data: { first_free_event_id: null } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisation_members.deleteMany({ where: { org_id: orgId } })
  await db.organisations.deleteMany({ where: { id: orgId } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

/** The task's SELECT, printed to the CI log. */
async function windowRow(when: string) {
  const [row] = await db.$queryRaw<{ analytics_free_until: Date | null; first_free_event_id: string | null }[]>`
    SELECT analytics_free_until, first_free_event_id FROM organisations WHERE id = ${orgId}::uuid`
  console.log(`READBACK ${when} ${JSON.stringify({ org: orgId, ...row })}`)
  return row
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
/** Everything on screen, the sidebar too: its plan card is the one nudge outside the page body. */
const screenText = (page: Page) => page.locator("body").innerText()
const planCard = (page: Page) => page.locator('[data-slot="plan-card"]')

async function open(baseURL: string, width: number) {
  const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 }, storageState: await sessionFor(baseURL, organizer) })
  const page = await ctx.newPage()
  await page.goto(`/dashboard/analytics?event=${canary}`)
  await expect(page.getByRole("heading", { name: new RegExp(`${tag} Sunday Soul on Ossington`) })).toBeVisible()
  return { ctx, page }
}

test("a Toronto organizer past its window sees its own figures and the launch line; in Bengaluru it locks; the window row is untouched", async ({ baseURL }) => {
  const before = await windowRow("before")
  expect(before.analytics_free_until!.getTime()).toBeLessThan(Date.now())

  for (const width of WIDTHS) {
    const { ctx, page } = await open(baseURL!, width)
    const status = page.getByRole("status").filter({ hasText: LINE })
    await expect(status).toHaveCount(1)
    await expect(status).toContainText("Every view, for every event.")
    await expect(page.getByText(STAY).first()).toBeVisible()
    await expect(page.getByText("Know which nights worked")).toHaveCount(0)
    await expect(planCard(page)).toHaveCount(0)
    expect(await screenText(page)).not.toMatch(NOTHING_TO_BUY)
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `${SCREENS}/04-analytics-toronto-${width}.png`, fullPage: true })
    await ctx.close()
  }
  expect(await windowRow("after Toronto reads")).toEqual(before)

  await db.events.updateMany({ where: { id: { in: events } }, data: { city: "Bengaluru", timezone: "Asia/Kolkata" } })
  for (const width of WIDTHS) {
    const { ctx, page } = await open(baseURL!, width)
    await expect(page.getByText(LINE)).toHaveCount(0)
    await expect(page.getByText("Know which nights worked")).toBeVisible()
    await expect(page.getByText(STAY)).toHaveCount(0)
    await expect(planCard(page)).toBeVisible()
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `${SCREENS}/04-analytics-bengaluru-${width}.png`, fullPage: true })
    await ctx.close()
  }
  expect(await windowRow("after Bengaluru reads")).toEqual(before)
})
