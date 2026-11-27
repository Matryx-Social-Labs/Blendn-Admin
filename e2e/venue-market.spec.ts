import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"

/**
 * SCRUM-1448 (task 04a) driven: a venue where Venue Pro is not sold is not
 * locked out of what it cannot buy. A venue organisation owns a Toronto venue
 * (a CA city in the catalogue's migration rows, its pin inside Toronto) and a
 * Bengaluru venue. The Toronto venue's page at 1280 and 390 shows its 12
 * months (the canary: 23 guests on a Monday morning 60 days ago, outside 30
 * days) and its history before the claim, says "free while we launch in your
 * city", and names no plan, no price and no Buy. The Bengaluru venue of the
 * same organisation is unchanged: 30 days, the locked preview and "See Venue
 * Pro". Moved to Bengaluru (label and pin), the Toronto venue locks at once.
 *
 * The task's read-back, printed before and after the reads: the venue rows,
 * their entitlements and their checkouts, none of which a read may change.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const tag = `e2e-venue-market-${randomUUID().slice(0, 8)}`
const DAY = 24 * 60 * 60 * 1000
const WIDTHS = [1280, 390] as const
const MARKET = "free while we launch in your city"
const SOLD = /₹|Venue Pro|See your plan|Buy|GST/
const SCREENS = "test-results/screens"
const TORONTO = { city: "Toronto", latitude: 43.6431, longitude: -79.4246, timezone: "America/Toronto" }
const BENGALURU = { city: "Bengaluru", latitude: 12.9716, longitude: 77.5946, timezone: "Asia/Kolkata" }

const users: string[] = []
const events: string[] = []
const venues: string[] = []
let owner = ""
let orgId = ""
let toronto = ""
let bengaluru = ""
let browser: Browser

async function person(label: string, role: "attendee" | "venue_owner" = "attendee") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u.id
}

async function venue(name: string, place: typeof TORONTO | typeof BENGALURU) {
  const v = await db.venues.create({
    data: { name: `${tag} ${name}`, ...place, owner_org_id: orgId, claimed_at: new Date(Date.now() - 100 * DAY) },
  })
  venues.push(v.id)
  return v.id
}

/** One night at the venue `daysAgo` days ago at `hour` UTC, with these guests checked in. */
async function night(venueId: string, daysAgo: number, hour: number, guests: string[]) {
  const start = new Date(Date.now() - daysAgo * DAY)
  start.setUTCHours(hour, 0, 0, 0)
  const end = new Date(start.getTime() + 3 * 60 * 60 * 1000)
  const e = await db.events.create({
    data: {
      slug: `${tag}-${venueId.slice(0, 8)}-${daysAgo}`,
      title: `${tag} night ${daysAgo}`,
      description: "e2e fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "completed",
      organizer_id: owner,
      venue_id: venueId,
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
}

async function sessionFor(baseURL: string, sub: string) {
  const { hostname, protocol } = new URL(baseURL)
  const token = await encode({ token: { sub, role: "venue_owner" }, secret: process.env.NEXTAUTH_SECRET!, maxAge: 3600 })
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
  owner = await person("owner", "venue_owner")
  orgId = (await db.organisations.create({ data: { kind: "company", display_name: `${tag} Queen West Hospitality`, status: "verified" } })).id
  await db.organisation_members.create({ data: { org_id: orgId, user_id: owner, role: "owner" } })
  toronto = await venue("The Drake Hotel Underground and Sky Yard Rooftop, Queen Street West", TORONTO)
  bengaluru = await venue("Toit Brewpub, Indiranagar 100 Feet Road", BENGALURU)
  const year: string[] = []
  for (let i = 0; i < 23; i++) year.push(await person(`y${i}`))
  const before: string[] = []
  for (let i = 0; i < 19; i++) before.push(await person(`b${i}`))
  for (const v of [toronto, bengaluru]) {
    // Inside a year, outside 30 days, after the claim: the 12-month canary.
    await night(v, 60, 9, year)
    // Before the claim (100 days ago): the pre-claim canary.
    await night(v, 130, 20, before)
  }
})

test.afterAll(async () => {
  await browser.close()
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: orgId } })
  await db.organisations.deleteMany({ where: { id: orgId } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

/** The task's SELECT, printed to the CI log: the venue rows, their entitlements and checkouts. */
async function readBack(when: string) {
  const rows = await db.$queryRaw<{ id: string; city: string | null; updated_at: Date; entitlements: bigint; checkouts: bigint }[]>`
    SELECT v.id::text, v.city, v.updated_at,
           (SELECT count(*) FROM entitlements e WHERE e.subject_kind = 'venue' AND e.subject_id = v.id) AS entitlements,
           (SELECT count(*) FROM billing_checkouts c WHERE c.venue_id = v.id) AS checkouts
      FROM venues v WHERE v.id = ANY(${venues}::uuid[]) ORDER BY v.name`
  const out = rows.map((r) => ({ ...r, entitlements: Number(r.entitlements), checkouts: Number(r.checkouts) }))
  console.log(`READBACK ${when} ${JSON.stringify(out)}`)
  return out
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const mainText = (page: Page) => page.locator("main").innerText()

async function open(baseURL: string, venueId: string, width: number) {
  const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 }, storageState: await sessionFor(baseURL, owner) })
  const page = await ctx.newPage()
  await page.goto(`/dashboard/venues/${venueId}`)
  await expect(page.getByText("Who comes, and when")).toBeVisible()
  return { ctx, page }
}

test("a Toronto venue reads its year and its past, names no plan; the Bengaluru one is unchanged; moved, it locks", async ({ baseURL }) => {
  const before = await readBack("before reads")
  expect(before.every((r) => r.entitlements === 0 && r.checkouts === 0)).toBe(true)

  for (const width of WIDTHS) {
    const { ctx, page } = await open(baseURL!, toronto, width)
    await expect(page.getByText(/last 12 months/)).toBeVisible()
    await expect(page.getByText(MARKET)).toBeVisible()
    await expect(page.getByText("Before you claimed it")).toBeVisible()
    await expect(page.getByText("Regulars & offers")).toHaveCount(0)
    await expect(page.locator("[data-locked-sample]")).toHaveCount(0)
    expect(await mainText(page)).not.toMatch(SOLD)
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `${SCREENS}/04a-venue-toronto-${width}.png`, fullPage: true })
    await ctx.close()
  }

  for (const width of WIDTHS) {
    const { ctx, page } = await open(baseURL!, bengaluru, width)
    await expect(page.getByText(/last 30 days/)).toBeVisible()
    await expect(page.getByText(MARKET)).toHaveCount(0)
    await expect(page.getByText("Before you claimed it")).toHaveCount(0)
    await expect(page.getByRole("link", { name: "See Venue Pro" }).first()).toBeVisible()
    await page.screenshot({ path: `${SCREENS}/04a-venue-bengaluru-${width}.png`, fullPage: true })
    await ctx.close()
  }
  expect(await readBack("after reads")).toEqual(before)

  // Label and pin moved to Bengaluru: the ordinary rule applies at once.
  await db.venues.update({ where: { id: toronto }, data: BENGALURU })
  const moved = await open(baseURL!, toronto, 1280)
  await expect(moved.page.getByText(/last 30 days/)).toBeVisible()
  await expect(moved.page.getByText("Before you claimed it")).toHaveCount(0)
  await moved.page.screenshot({ path: `${SCREENS}/04a-venue-moved-1280.png`, fullPage: true })
  await moved.ctx.close()
  const after = await readBack("after the move")
  expect(after.map((r) => ({ entitlements: r.entitlements, checkouts: r.checkouts }))).toEqual(before.map(() => ({ entitlements: 0, checkouts: 0 })))
})
