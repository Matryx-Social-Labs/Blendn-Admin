import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"

/**
 * SCRUM-1320 driven: a venue is chargeable three months (90 days) after its
 * first venue-day check-in. A venue owner whose venue had its first guest go
 * live 40 days ago opens /dashboard/plan at 1280 and 390: "40 of 90 days of
 * data" and the no-charge date, read back from the database as the first
 * check-in + 90 days; no Buy; nothing wider than the viewport. /pricing says
 * three months. The buy action's refusal text is pinned against real Postgres
 * in venue-plans.itest.ts: CI has no Razorpay keys, so the page offers no Buy
 * to click. Run in CI because the host was over the load limit for a local
 * dev server.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const DAY = 24 * 60 * 60 * 1000
const tag = `e2e-venue-90-${randomUUID().slice(0, 8)}`
const PLAN_DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
const WIDTHS = [1280, 390] as const

const users: string[] = []
let owner = ""
let orgId = ""
let venueId = ""
let dayId = ""
let browser: Browser

async function person(label: string, role: "attendee" | "venue_owner" = "attendee") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u.id
}

async function sessionFor(baseURL: string) {
  const { hostname, protocol } = new URL(baseURL)
  const token = await encode({ token: { sub: owner, role: "venue_owner" }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })
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
  owner = await person("owner", "venue_owner")
  orgId = (await db.organisations.create({ data: { kind: "company", display_name: `${tag} org`, status: "verified" } })).id
  await db.organisation_members.create({ data: { org_id: orgId, user_id: owner, role: "owner" } })
  const venue = await db.venues.create({
    data: {
      name: `${tag} venue`,
      city: "Bengaluru",
      latitude: 12.97,
      longitude: 77.64,
      timezone: "Asia/Kolkata",
      day_reset_hour: 6,
      owner_org_id: orgId,
      claimed_at: new Date(Date.now() - 100 * DAY),
    },
  })
  venueId = venue.id
  // The venue's own live room 40 days ago (lib/venue-day.ts's shape), and one guest who went live in it
  // exactly 40 days ago, so the page's floor reads 40 (a check-in an hour later would read 39).
  const wentLive = new Date(Date.now() - 40 * DAY)
  const start = new Date(wentLive.getTime() - 60 * 60 * 1000)
  const end = new Date(start.getTime() + DAY)
  const day = await db.events.create({
    data: {
      slug: `${tag}-day`,
      kind: "venue_day",
      title: `Venue day · ${venue.name}`,
      description: "",
      venue_id: venueId,
      venue_name: venue.name,
      city: venue.city,
      latitude: venue.latitude,
      longitude: venue.longitude,
      start_time: start,
      end_time: end,
      timezone: venue.timezone,
      status: "published",
      visibility: "unlisted",
      organizer_id: "blendn-system",
      organizer_org_id: null,
    },
  })
  dayId = day.id
  const occ = await db.event_occurrences.create({
    data: { event_id: dayId, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  await db.event_check_ins.create({
    data: {
      event_id: dayId,
      occurrence_id: occ.id,
      user_id: await person("guest"),
      kind: "attendee",
      status: "checked_out",
      check_in_time: wentLive,
      check_out_time: new Date(wentLive.getTime() + 2 * 60 * 60 * 1000),
    },
  })
})

test.afterAll(async () => {
  await browser.close()
  // Guarded, so a failed beforeAll reports its own error rather than '' as a uuid.
  if (dayId) {
    await db.event_check_ins.deleteMany({ where: { event_id: dayId } })
    await db.event_occurrences.deleteMany({ where: { event_id: dayId } })
    await db.events.deleteMany({ where: { id: dayId } })
  }
  if (venueId) await db.venues.deleteMany({ where: { id: venueId } })
  if (orgId) {
    await db.organisation_members.deleteMany({ where: { org_id: orgId } })
    await db.organisations.deleteMany({ where: { id: orgId } })
  }
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

/** Nothing on the page is wider than the viewport. */
async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test("the venue Plan page says 40 of 90 days and the no-charge date the database gives", async ({ baseURL }) => {
  // The read-back: the task's SELECT, with venueDataSince's guest filter.
  const [{ first }] = await db.$queryRaw<{ first: Date }[]>`
    SELECT min(c.check_in_time) AS first FROM event_check_ins c JOIN events e ON e.id = c.event_id
     WHERE e.kind = 'venue_day' AND e.venue_id = ${venueId}::uuid
       AND c.kind = 'attendee' AND c.status IN ('checked_in', 'checked_out')`
  expect(first).toBeInstanceOf(Date)
  const noChargeBefore = PLAN_DAY.format(new Date(first.getTime() + 90 * DAY))
  console.log(`READBACK ${JSON.stringify({ venue: venueId, first, plus90: new Date(first.getTime() + 90 * DAY), shown: noChargeBefore })}`)

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 }, storageState: await sessionFor(baseURL!) })
    const page = await ctx.newPage()
    await page.goto("/dashboard/plan")
    await expect(page.getByText(`40 of 90 days of data · no charge before ${noChargeBefore}`)).toBeVisible()
    await expect(page.getByRole("meter", { name: `Days of data at ${tag} venue` })).toHaveAttribute("aria-valuemax", "90")
    await expect(page.getByText("Nothing is charged until a venue has three months of data from people going live there.")).toBeVisible()
    await expect(page.getByText(/weeks/)).toHaveCount(0)
    await expect(page.getByRole("radio")).toHaveCount(0)
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await ctx.close()
  }
})

test("/pricing says three months for venues", async ({ baseURL }) => {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 } })
    const page = await ctx.newPage()
    await page.goto("/pricing")
    await expect(page.getByText("Venue Pro can be bought once the venue has three months of data.")).toBeVisible()
    await expect(page.getByText(/four weeks/)).toHaveCount(0)
    expect(await overflow(page), `pricing overflow at ${width}`).toBeLessThanOrEqual(0)
    await ctx.close()
  }
})

// SCRUM-1340: Blend'n+ is out of 1.0 (DECISIONS gate 5), and one event's product has one name.
const NOT_SOLD = /Blend['’]?n\s*(\+|plus\b)|Event\s+Pass/i

test("/pricing and the Venue Pro card sell no Blend'n+ and name Event Insights only", async ({ baseURL }) => {
  for (const width of [1280, 768] as const) {
    const anon = await browser.newContext({ baseURL, viewport: { width, height: 900 } })
    const pricing = await anon.newPage()
    await pricing.goto("/pricing")
    const text = await pricing.locator("body").innerText()
    expect(text).not.toMatch(NOT_SOLD)
    await expect(pricing.getByText("Event Insights is a single payment", { exact: false })).toBeVisible()
    expect(await overflow(pricing), `pricing overflow at ${width}`).toBeLessThanOrEqual(0)
    // The read-back: every "Blend" on the page is the brand name.
    console.log(`READBACK ${JSON.stringify({ width, blend: text.match(/Blend/g)?.length ?? 0, brand: text.match(/Blend['’]n(?!\+)/g)?.length ?? 0 })}`)
    await anon.close()

    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 }, storageState: await sessionFor(baseURL!) })
    const plan = await ctx.newPage()
    await plan.goto("/dashboard/plan")
    await expect(plan.getByText("Blind offers to your regulars, with a monthly send quota (coming)")).toBeVisible()
    expect(await plan.locator("body").innerText()).not.toMatch(NOT_SOLD)
    expect(await overflow(plan), `plan overflow at ${width}`).toBeLessThanOrEqual(0)
    await ctx.close()
  }
})
