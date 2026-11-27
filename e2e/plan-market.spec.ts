import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"

/**
 * SCRUM-1151 driven: plans are sold only in India. An organisation whose one
 * event is in Toronto (a CA city in the catalogue's migration rows) opens
 * /dashboard/plan at 1280 and 768 and sees "Free while we launch in your
 * city." in place of each paid card's price, no Buy and no rupee; moved to
 * Bengaluru, the prices and Buy return. A venue owner whose venue is in
 * Toronto sees the line once and no Buy. The task's read-back: no
 * `billing_checkouts` row and no `payment_events` row for either organisation.
 *
 * The refusal of a direct call to each checkout action (Analytics, Event
 * Insights, Venue Pro) is pinned in plan-market.itest.ts against real Postgres
 * with Razorpay keys set and the API stubbed: CI's server has no keys, so a
 * POST here would be refused for that reason first and prove nothing.
 * Run in CI because the host was over the load limit for a local dev server;
 * the screenshots are kept as the `e2e-screens` artefact.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const tag = `e2e-plan-market-${randomUUID().slice(0, 8)}`
const WIDTHS = [1280, 768] as const
const LINE = "Free while we launch in your city."
const SCREENS = "test-results/screens"

const users: string[] = []
const orgs: string[] = []
let organizer = ""
let orgId = ""
let eventId = ""
let venueOwner = ""
let venueOrg = ""
let venueId = ""
let browser: Browser

async function person(label: string, role: "organizer" | "venue_owner") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u.id
}

async function orgOf(owner: string, name: string) {
  const org = await db.organisations.create({ data: { kind: "company", display_name: name, status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: owner, role: "owner" } })
  return org.id
}

async function sessionFor(baseURL: string, sub: string, role: "organizer" | "venue_owner") {
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
  mkdirSync(SCREENS, { recursive: true })
  organizer = await person("organizer", "organizer")
  orgId = await orgOf(organizer, `${tag} The Queen Street West Late-Night Creative Collective and Friends of the Distillery District`)
  const start = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
  eventId = (
    await db.events.create({
      data: {
        slug: tag,
        title: `${tag} Thursday on Queen West`,
        description: "e2e fixture",
        start_time: start,
        end_time: new Date(start.getTime() + 4 * 60 * 60 * 1000),
        timezone: "America/Toronto",
        status: "published",
        city: "Toronto",
        // A label is market evidence only with its pin inside the city (SCRUM-1447).
        latitude: 43.6431,
        longitude: -79.4246,
        organizer_id: organizer,
        organizer_org_id: orgId,
      },
    })
  ).id

  venueOwner = await person("venue", "venue_owner")
  venueOrg = await orgOf(venueOwner, `${tag} Drake Hospitality`)
  venueId = (
    await db.venues.create({
      data: {
        name: `${tag} The Drake Hotel Underground and Sky Yard Rooftop, Queen Street West`,
        city: "Toronto",
        latitude: 43.6431,
        longitude: -79.4246,
        timezone: "America/Toronto",
        owner_org_id: venueOrg,
        claimed_at: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      },
    })
  ).id
})

test.afterAll(async () => {
  await browser.close()
  await db.events.deleteMany({ where: { id: eventId } })
  await db.venues.deleteMany({ where: { id: venueId } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

/** The page's main content, as text: what a person reads. */
const mainText = (page: Page) => page.locator("main").innerText()

async function open(baseURL: string, sub: string, role: "organizer" | "venue_owner", width: number) {
  const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 }, storageState: await sessionFor(baseURL, sub, role) })
  const page = await ctx.newPage()
  await page.goto("/dashboard/plan")
  await expect(page.getByRole("region", { name: role === "organizer" ? "Analytics plan" : "Venue Pro plan" })).toBeVisible()
  return { ctx, page }
}

/** What the task reads back: nothing was started or paid for this organisation. */
async function readBack(org: string) {
  const [row] = await db.$queryRaw<{ checkouts: bigint; payment_events: bigint }[]>`
    SELECT (SELECT count(*) FROM billing_checkouts WHERE org_id = ${org}::uuid) AS checkouts,
           (SELECT count(*) FROM payment_events p JOIN billing_checkouts c ON c.id = p.checkout_id WHERE c.org_id = ${org}::uuid) AS payment_events`
  return { checkouts: Number(row.checkouts), paymentEvents: Number(row.payment_events) }
}

test("a Toronto organizer sees the launch line and no Buy; in Bengaluru the prices return", async ({ baseURL }) => {
  for (const width of WIDTHS) {
    const { ctx, page } = await open(baseURL!, organizer, "organizer", width)
    await expect(page.getByText(LINE)).toHaveCount(2)
    await expect(page.getByRole("button", { name: /Start Analytics/ })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Buy Event Insights/ })).toHaveCount(0)
    expect(await mainText(page)).not.toMatch(/₹|GST/)
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `${SCREENS}/05-plan-toronto-organizer-${width}.png`, fullPage: true })
    await ctx.close()
  }
  const toronto = await readBack(orgId)
  console.log(`READBACK toronto organizer ${JSON.stringify({ org: orgId, ...toronto })}`)
  expect(toronto).toEqual({ checkouts: 0, paymentEvents: 0 })

  await db.events.update({ where: { id: eventId }, data: { city: "Bengaluru", latitude: 12.9716, longitude: 77.5946, timezone: "Asia/Kolkata" } })
  for (const width of WIDTHS) {
    const { ctx, page } = await open(baseURL!, organizer, "organizer", width)
    await expect(page.getByText(LINE)).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Start Analytics · ₹2,359 \/ month/ })).toBeVisible()
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `${SCREENS}/05-plan-bengaluru-organizer-${width}.png`, fullPage: true })
    await ctx.close()
  }
})

test("a Toronto venue owner sees the launch line once and no Buy", async ({ baseURL }) => {
  for (const width of WIDTHS) {
    const { ctx, page } = await open(baseURL!, venueOwner, "venue_owner", width)
    await expect(page.getByText(LINE)).toHaveCount(1)
    await expect(page.getByRole("button", { name: /Start Venue Pro/ })).toHaveCount(0)
    await expect(page.getByRole("meter")).toHaveCount(0)
    await expect(page.getByText(/The Drake Hotel Underground/)).toBeVisible()
    expect(await mainText(page)).not.toMatch(/₹|GST|no charge before/)
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `${SCREENS}/05-plan-toronto-venue-${width}.png`, fullPage: true })
    await ctx.close()
  }
  const venue = await readBack(venueOrg)
  console.log(`READBACK toronto venue owner ${JSON.stringify({ org: venueOrg, venue: venueId, ...venue })}`)
  expect(venue).toEqual({ checkouts: 0, paymentEvents: 0 })
})
