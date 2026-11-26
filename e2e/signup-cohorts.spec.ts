import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"

import { dayInIndia } from "../lib/dashboard-format"

/**
 * SCRUM-1281 driven: the admin overview's "Sign-ups by week". People in three
 * India weeks: six weeks back, five RSVP'd within 7 days and one on day 8, one
 * whose only check-in is a venue day, one at a second event on day 31 and one
 * on day 20; three weeks back, a few; five days back, one who checked in the
 * next day and still reads "not yet known" for the 14-day stage. At 1280 and
 * 768 the panel shows and nothing is wider than the viewport; the six-weeks-
 * back RSVP cell equals the task's SELECT, both printed. An organizer's
 * overview has no panel. Run in CI because the host was over the load limit
 * for a local dev server.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const DAY = 24 * 60 * 60 * 1000
const tag = `e2e-cohorts-${randomUUID().slice(0, 8)}`
const WIDTHS = [1280, 768] as const

const users: string[] = []
const events: string[] = []
let venueId = ""
let admin = ""
let organizer = ""
let weekA = ""
let weekC = ""
let browser: Browser

async function person(label: string, role: "attendee" | "organizer" | "app_admin" = "attendee", createdAt?: Date) {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role, ...(createdAt ? { createdAt } : {}) } })
  users.push(u.id)
  return u.id
}

async function night(data: Record<string, unknown> = {}) {
  const start = new Date(Date.now() - 60 * DAY)
  const e = await db.events.create({
    data: {
      slug: `${tag}-${events.length}`,
      title: `${tag} night`,
      description: "e2e fixture",
      start_time: start,
      end_time: new Date(Date.now() + DAY),
      timezone: "Asia/Kolkata",
      status: "published",
      organizer_id: organizer,
      ...data,
    },
  })
  events.push(e.id)
  const occ = await db.event_occurrences.create({
    data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: e.end_time },
  })
  return { id: e.id, occ: occ.id }
}

const came = (n: { id: string; occ: string }, user_id: string, at: Date) =>
  db.event_check_ins.create({
    data: { event_id: n.id, occurrence_id: n.occ, user_id, status: "checked_out", check_in_time: at, check_out_time: new Date(at.getTime() + 3600_000) },
  })

/** The Monday (India) of the week `daysAgo` days back, as YYYY-MM-DD. */
async function weekOf(daysAgo: number) {
  const [row] = await db.$queryRaw<{ week: string }[]>`
    SELECT to_char(date_trunc('week', (now() - make_interval(days => ${daysAgo}::int)) AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS week`
  return row.week
}

const tuesdayNoon = (week: string) => new Date(new Date(`${week}T12:00:00+05:30`).getTime() + DAY)
const after = (from: Date, days: number) => new Date(from.getTime() + days * DAY)

async function sessionFor(baseURL: string, sub: string, role: "app_admin" | "organizer") {
  const { hostname, protocol } = new URL(baseURL)
  const token = await encode({ token: { sub, role }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })
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
  admin = await person("admin", "app_admin")
  organizer = await person("organizer", "organizer")
  const first = await night()
  const second = await night()
  venueId = (await db.venues.create({ data: { name: `${tag} venue`, city: "Bengaluru" } })).id
  const venueDay = await night({ kind: "venue_day", venue_id: venueId, visibility: "unlisted" })

  // Six weeks back: every window has closed.
  weekA = await weekOf(42)
  const a = tuesdayNoon(weekA)
  for (let i = 0; i < 5; i++) {
    const id = await person(`a${i}`, "attendee", a)
    await db.event_rsvps.create({ data: { event_id: first.id, user_id: id, status: "going", created_at: after(a, 6) } })
  }
  const late = await person("a-late", "attendee", a)
  await db.event_rsvps.create({ data: { event_id: first.id, user_id: late, status: "going", created_at: after(a, 7.5) } })
  await came(venueDay, await person("a-venue", "attendee", a), after(a, 1))
  const day31 = await person("a-day31", "attendee", a)
  await came(first, day31, after(a, 3))
  await came(second, day31, after(a, 30.5))
  await came(first, await person("a-day20", "attendee", a), after(a, 20))

  // Three weeks back: a few.
  const b = tuesdayNoon(await weekOf(21))
  for (let i = 0; i < 3; i++) await person(`b${i}`, "attendee", b)

  // Five days back, checked in the next day: the 14-day stage is not known yet.
  const c = new Date(Date.now() - 5 * DAY)
  weekC = await weekOf(5)
  await came(first, await person("c-young", "attendee", c), after(c, 1))
})

test.afterAll(async () => {
  await browser.close()
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: venueId } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

/** A week's row in the weeks table: its first cell starts with the week's label. */
function weekRow(page: Page, week: string) {
  const label = dayInIndia(`${week}T00:00:00+05:30`)
  return page
    .getByRole("table", { name: "Sign-ups by week" })
    .locator("tbody tr")
    .filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${label}`) }) })
}

test("the admin overview shows sign-ups by week, and one cell is what the database says", async ({ baseURL }) => {
  // The task's SELECT, with "createdAt" read as the UTC it holds, and the overview's own exclusions.
  const [read] = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "User" u
    WHERE date_trunc('week', (u."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata') = ${weekA}::timestamp
      AND u."deletedAt" IS NULL AND u.id <> 'blendn-system'
      AND EXISTS (SELECT 1 FROM event_rsvps r WHERE r.user_id = u.id AND r.created_at < (u."createdAt" AT TIME ZONE 'UTC') + interval '7 days')`
  const expected = Number(read.n)
  expect(expected).toBeGreaterThanOrEqual(5)

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 1000 }, storageState: await sessionFor(baseURL!, admin, "app_admin") })
    const page = await ctx.newPage()
    await page.goto("/dashboard")
    const panel = page.getByRole("heading", { name: "Sign-ups by week" })
    await expect(panel).toBeVisible()
    await expect(page.getByRole("table", { name: "Sign-ups by week" }).locator("tbody tr")).toHaveCount(8)

    const rsvp = (await weekRow(page, weekA).locator("td:nth-child(3)").innerText()).split("\n")[0]
    console.log(`READBACK ${JSON.stringify({ width, week: weekA, select: expected, cell: rsvp })}`)
    expect(Number(rsvp.replace(/,/g, ""))).toBe(expected)

    // Five days old: checked in the next day, and the 14-day stage still says it is not known.
    await expect(weekRow(page, weekC).locator("td:nth-child(4)")).toHaveText("—not yet known")
    await expect(page.getByRole("table", { name: "Sign-ups by where they came from" })).toBeVisible()
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await panel.scrollIntoViewIfNeeded()
    await test.info().attach(`cohorts-${width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
    await ctx.close()
  }
})

test("an organizer's overview has no sign-ups panel", async ({ baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, storageState: await sessionFor(baseURL!, organizer, "organizer") })
  const page = await ctx.newPage()
  const response = await page.goto("/dashboard")
  expect(response?.status()).toBe(200)
  await expect(page.locator("main")).toBeVisible()
  await expect(page.getByText("Sign-ups by week")).toHaveCount(0)
  expect(await page.content()).not.toContain("Sign-ups by where they came from")
  await ctx.close()
})
