import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import type { RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The alert log, once the event is over (F6), in a real browser.
 *
 * `event_issues` is what the room's watch recorded while the event ran, and the
 * Live tab was its only reader. That tab exists only while the event runs, so
 * the morning after there was no screen for it. It is the Overview's "Alert
 * history" now, for an event that is over: the host reads the bodies as
 * recorded, and nobody reads a name — the rows are counts and conditions.
 *
 * The seeded past event (Monsoon Flea Market) gets two rows for the length of
 * the spec and loses them after, pass or fail.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
let browser: Browser
let eventId = ""
const rowIds: string[] = []

test.beforeAll(async () => {
  browser = await chromium.launch()
  const event = await db.events.findFirst({ where: { slug: "monsoon-flea-market", deleted_at: null }, select: { id: true, end_time: true } })
  if (!event) throw new Error("seeded past event missing — run seed:qa --apply")
  eventId = event.id
  const end = event.end_time.getTime()
  const at = (minutesBeforeEnd: number) => new Date(end - minutesBeforeEnd * 60_000)
  const made = await db.$transaction([
    db.event_issues.create({
      data: {
        event_id: eventId,
        kind: "over_capacity",
        severity: "critical",
        title: "Over capacity",
        body: "132 inside against a capacity of 120",
        opened_at: at(90),
        last_seen_at: at(68),
        resolved_at: at(68),
      },
      select: { id: true },
    }),
    db.event_issues.create({
      data: {
        event_id: eventId,
        kind: "leaving_early",
        severity: "warning",
        title: "Leaving early",
        body: "7 of 18 have checked out",
        opened_at: at(40),
        last_seen_at: at(5),
      },
      select: { id: true },
    }),
  ])
  rowIds.push(...made.map((m) => m.id))
})

test.afterAll(async () => {
  await browser.close()
  try {
    await db.event_issues.deleteMany({ where: { id: { in: rowIds } } })
  } finally {
    await db.$disconnect()
  }
})

async function axeMain(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })
  return page.evaluate(async () => {
    type Axe = { run: (...a: unknown[]) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> }
    const res = await (window as unknown as { axe: Axe }).axe.run({ include: [["main"]] }, { resultTypes: ["violations"] })
    return res.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
  })
}

async function open(account: RoleKey, width: number, baseURL: string | undefined) {
  const ctx = await browser.newContext({ storageState: statePathFor(account), viewport: { width, height: 900 }, baseURL })
  const page = await ctx.newPage()
  await page.goto(`/dashboard/events/${eventId}`, { waitUntil: "networkidle" })
  return { ctx, page }
}

const panel = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "Alert history" }) })

test("the host reads what the watch recorded, how each ended, at 375, 768 and 1440", async ({ baseURL }) => {
  test.setTimeout(120_000)
  const rows: string[] = []
  for (const width of [375, 768, 1440]) {
    const { ctx, page } = await open("admin", width, baseURL)
    const p = panel(page)
    await expect(p).toBeVisible()
    await expect(p.getByText("Over capacity")).toBeVisible()
    await expect(p.getByText("132 inside against a capacity of 120")).toBeVisible()
    await expect(p.getByText(/lasted 22 min/)).toBeVisible()
    await expect(p.getByText("Leaving early")).toBeVisible()
    await expect(p.getByText(/still on when it ended, for at least 35 min/)).toBeVisible()
    // A record: nothing is ongoing, and nothing is tonight's.
    await expect(p.getByText(/ongoing/)).toHaveCount(0)

    const h1s = await page.getByRole("heading", { level: 1 }).count()
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    const axe = await axeMain(page)
    rows.push(`admin @${width}: h1 ${h1s} · sideways ${sideways}px · axe ${axe.length} serious`)
    expect(h1s).toBe(1)
    expect(sideways).toBe(0)
    expect(axe).toEqual([])
    await ctx.close()
  }
  console.log(`\n${rows.join("\n")}\n`)
})

test("the Live tab is not how in: it does not exist once the event is over, and the URL lands on the Overview", async ({ baseURL }) => {
  const { ctx, page } = await open("admin", 1440, baseURL)
  await expect(page.getByRole("navigation", { name: "Event sections" }).getByRole("link", { name: "Live" })).toHaveCount(0)
  await page.goto(`/dashboard/events/${eventId}?tab=live`, { waitUntil: "networkidle" })
  expect(new URL(page.url()).pathname).toBe(`/dashboard/events/${eventId}`)
  await expect(panel(page)).toBeVisible()
  await ctx.close()
})

test("the organiser who ran it reads the same record", async ({ baseURL }) => {
  const { ctx, page } = await open("organizer", 1440, baseURL)
  const p = panel(page)
  await expect(p).toBeVisible()
  await expect(p.getByText("132 inside against a capacity of 120")).toBeVisible()
  await expect(p.getByText("7 of 18 have checked out")).toBeVisible()
  await ctx.close()
})

// A venue on another host's night gets each alert as a sentence with no figure
// (`alertsForVenue`): held in `event-alert-history.test.tsx`. Not driven here,
// because the seed's venue claim is stamped at seed time and a venue never
// opens an event that began before it was claimed.
