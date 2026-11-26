import { test, expect, chromium, type Browser } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { encode } from "next-auth/jwt"
import { randomUUID } from "node:crypto"

import { MIN_CELL } from "../lib/disclosure"

/**
 * SCRUM-1363 driven: Event Insights is sold only for a night that has ended
 * with at least MIN_CELL (5) people checked in. An organisation past its free
 * window (its first night of 8 ended 120 days ago, open for good) has an ended
 * night of 4, an ended night of 5 with a three-line title, and a night still to
 * come. /dashboard/plan at 1280 and 768 offers the night of 5 and nothing
 * else, says the floor under the picker, and nothing is wider than the
 * viewport. The task's SELECT is read back: every listed night has 5 or more.
 * The checkout refusal for the night of 4 is pinned in billing-actions.itest.ts
 * against real Postgres: CI has no Razorpay keys, so there is no Buy to press.
 * Run in CI because the host was over the load limit for a local dev server.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const DAY = 24 * 60 * 60 * 1000
const tag = `e2e-pass-floor-${randomUUID().slice(0, 8)}`
const WIDTHS = [1280, 768] as const
const LONG = "Thiruvananthapuram Founders, Operators and First-Time Builders Winter Mixer with the Kochi Design Collective and Friends"

const users: string[] = []
const events: string[] = []
let orgId = ""
let owner = ""
let five = ""
let four = ""
let coming = ""
let browser: Browser

async function person(label: string, role: "attendee" | "organizer" = "attendee") {
  const u = await db.user.create({ data: { email: `${tag}-${label}@e2e.invalid`, name: `${tag} ${label}`, role } })
  users.push(u.id)
  return u.id
}

/** A night of this organisation's that ended `endedDaysAgo` days ago (negative: still to come), with these guests. */
async function night(title: string, endedDaysAgo: number, guests: string[]) {
  const end = new Date(Date.now() - endedDaysAgo * DAY)
  const start = new Date(end.getTime() - 4 * 60 * 60 * 1000)
  const e = await db.events.create({
    data: {
      slug: `${tag}-${events.length}`,
      title,
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
  return e.id
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
  // Past the free window: 120 days ago + 90 (lib/analytics-access.ts). Open for good, so never for sale.
  await night(`${tag} first of eight`, 120, guests)
  four = await night(`${tag} night of four`, 20, guests.slice(0, MIN_CELL - 1))
  five = await night(`${tag} ${LONG}`, 10, guests.slice(0, MIN_CELL))
  coming = await night(`${tag} still to come`, -3, guests)
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

test("the Plan page offers Event Insights only for the ended night of 5, and says why", async ({ baseURL }) => {
  let offered: string[] = []
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 }, storageState: await sessionFor(baseURL!) })
    const page = await ctx.newPage()
    await page.goto("/dashboard/plan")
    const picker = page.getByRole("region", { name: "Event Insights plan" }).locator('select[aria-describedby="event-pass-floor"]')
    await expect(picker).toBeVisible()
    offered = await picker.locator("option").evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))
    expect(offered).toEqual([five])
    await expect(
      page.getByText(`Nights with fewer than ${MIN_CELL} people checked in have nothing to show, so they can't be bought.`).filter({ visible: true })
    ).toBeVisible()
    expect(await overflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await ctx.close()
  }

  // The read-back, as the task writes it.
  const rows = await db.$queryRaw<{ id: string; title: string; people: bigint }[]>`
    SELECT e.id, e.title, count(DISTINCT c.user_id) AS people
    FROM events e LEFT JOIN event_check_ins c ON c.event_id = e.id
    WHERE e.organizer_org_id = ${orgId}::uuid AND e.end_time < now()
    GROUP BY 1, 2`
  const people = new Map(rows.map((r) => [r.id, Number(r.people)]))
  console.log(`READBACK ${JSON.stringify({ org: orgId, offered, rows: rows.map((r) => ({ id: r.id, people: Number(r.people) })), four, five, coming })}`)
  for (const id of offered) expect(people.get(id)).toBeGreaterThanOrEqual(MIN_CELL)
  expect(people.get(four)).toBe(MIN_CELL - 1)
  expect(people.has(coming)).toBe(false)
})
