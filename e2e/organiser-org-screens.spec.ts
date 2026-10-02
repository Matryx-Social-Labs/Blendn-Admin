import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import type { RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The rest of the organiser's screens on the kit (step 15, part 3): the event
 * form's panels and its "Before it can go out" rail, Attendees, Chatrooms,
 * Team, Reports and Audit — each with one h1, each clean under axe inside
 * `main` at a phone's width and a desktop's.
 */

let browser: Browser
test.beforeAll(async () => {
  browser = await chromium.launch()
})
test.afterAll(async () => {
  await browser.close()
})

async function open(account: RoleKey, width: number, baseURL: string | undefined) {
  const ctx = await browser.newContext({ storageState: statePathFor(account), viewport: { width, height: 900 }, baseURL })
  return { ctx, page: await ctx.newPage() }
}

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

const main = (page: Page) => page.getByRole("main")

const SCREENS: Array<{ path: string; h1: string; check: (page: Page) => Promise<void> }> = [
  {
    path: "/dashboard/events/new",
    h1: "New event",
    check: async (page) => {
      for (const name of ["Basics", "When", "Where", "Who can come"]) {
        await expect(main(page).getByRole("heading", { name })).toBeVisible()
      }
    },
  },
  {
    path: "/dashboard/attendees",
    h1: "Attendees",
    check: async (page) => {
      for (const label of ["Unique attendees", "Came back", "No-show rate"]) {
        await expect(main(page).getByText(label, { exact: true })).toBeVisible()
      }
    },
  },
  {
    path: "/dashboard/chatrooms",
    h1: "Chatrooms",
    check: async (page) => {
      // Either a card per open room, each with its way in, or the empty state.
      const rooms = main(page).getByRole("link", { name: /^Open room/ })
      const empty = main(page).getByText("No rooms open")
      await expect(rooms.first().or(empty)).toBeVisible()
    },
  },
  {
    path: "/dashboard/organisation",
    h1: "Team",
    check: async (page) => {
      await expect(main(page).getByRole("heading", { name: "Members" })).toBeVisible()
    },
  },
  {
    path: "/dashboard/reports",
    h1: "Reports",
    check: async (page) => {
      // A CSV button per report, named by the report it downloads.
      await expect(main(page).getByRole("button", { name: /^Download Events CSV$/ })).toBeVisible()
    },
  },
  { path: "/dashboard/audit", h1: "Audit log", check: async () => {} },
]

test("each screen: one h1, the kit's pieces, and nothing serious under axe, at 375 and 1440", async ({ baseURL }) => {
  test.setTimeout(240_000)
  const found: string[] = []
  for (const width of [375, 1440]) {
    const { ctx, page } = await open("organizer", width, baseURL)
    for (const screen of SCREENS) {
      await page.goto(screen.path, { waitUntil: "networkidle" })
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(screen.h1)
      await screen.check(page)
      found.push(...(await axeMain(page)).map((v) => `${screen.path}@${width}: ${v}`))
    }
    await ctx.close()
  }
  expect(found).toEqual([])
})

test("a report downloads from its own row", async ({ baseURL }) => {
  const { ctx, page } = await open("organizer", 1440, baseURL)
  await page.goto("/dashboard/reports", { waitUntil: "networkidle" })
  const download = page.waitForEvent("download")
  await main(page).getByRole("button", { name: /^Download Events CSV$/ }).click()
  expect((await download).suggestedFilename()).toMatch(/\.csv$/)
  await ctx.close()
})

/* -------------------------------------------------------------------------- */
/* The venue owner and the admin on the same screens                           */
/* -------------------------------------------------------------------------- */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })

test.describe("the venue owner and the admin", () => {
  let roomId = ""
  let roomTitle = ""

  /*
   * A live room another organisation runs at the venue owner's building: what
   * the venue sees as ranges. Made here, not borrowed from the seed, whose
   * live nights move with its clock; removed after.
   */
  test.beforeAll(async () => {
    const venue = await db.venues.findFirst({ where: { name: "The Humming Tree", claimed_at: { not: null } }, select: { id: true, claimed_at: true } })
    const host = await db.organisations.findFirst({ where: { display_name: "Nightshift Collective" }, select: { id: true } })
    const organiser = await db.user.findUnique({ where: { email: "organizer@blendn.app" }, select: { id: true } })
    expect(venue && host && organiser, "the seed's venue, host and organiser").toBeTruthy()
    roomTitle = `Room for the venue ${Date.now()}`
    const start = new Date(Date.now() - 60 * 60_000)
    const event = await db.events.create({
      data: {
        slug: `e2e-venue-room-${Date.now()}`,
        title: roomTitle,
        description: "e2e fixture",
        start_time: start,
        end_time: new Date(start.getTime() + 4 * 60 * 60_000),
        timezone: "Asia/Kolkata",
        status: "published",
        organizer_id: organiser!.id,
        organizer_org_id: host!.id,
        venue_id: venue!.id,
        venue_name: "The Humming Tree",
      },
    })
    roomId = event.id
    await db.event_occurrences.create({
      data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: event.end_time },
    })
    await db.chat_groups.create({ data: { event_id: event.id, name: roomTitle } })
  })

  test.afterAll(async () => {
    if (roomId) {
      await db.chat_groups.deleteMany({ where: { event_id: roomId } })
      await db.event_occurrences.deleteMany({ where: { event_id: roomId } })
      await db.events.deleteMany({ where: { id: roomId } })
    }
    await db.$disconnect()
  })

  test("venue owner: no Attendees screen, another host's room in ranges, the venue's reports, clean under axe", async ({
    baseURL,
  }) => {
    const found: string[] = []
    const { ctx, page } = await open("venue", 1440, baseURL)

    // Attendees is the organiser's: the venue is sent home.
    await page.goto("/dashboard/attendees", { waitUntil: "networkidle" })
    await expect(page).toHaveURL(/\/dashboard$/)

    await page.goto("/dashboard/chatrooms", { waitUntil: "networkidle" })
    const card = main(page).locator("section", { has: page.getByRole("heading", { name: roomTitle }) })
    await expect(card).toBeVisible()
    for (const label of ["inside", "messages", "flags"]) {
      const value = await card.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd").innerText()
      expect(value, `${label} is a range for the venue`).toMatch(/^(Under 5|5–9|10–19|20\+)$/)
    }
    await expect(main(page).getByText(/flags? waiting|people inside|person inside/)).toHaveCount(0)
    found.push(...(await axeMain(page)).map((v) => `venue chatrooms: ${v}`))

    await page.goto("/dashboard/reports", { waitUntil: "networkidle" })
    for (const name of ["Download Events CSV", "Download Check-ins CSV", "Download Venue check-ins CSV"]) {
      await expect(main(page).getByRole("button", { name })).toBeVisible()
    }
    for (const name of ["Download Attendees CSV", "Download Ratings CSV", "Download Moderation CSV"]) {
      await expect(main(page).getByRole("button", { name })).toHaveCount(0)
    }
    found.push(...(await axeMain(page)).map((v) => `venue reports: ${v}`))
    await ctx.close()
    expect(found).toEqual([])
  })

  test("admin: the same room exactly, and the platform's reports", async ({ baseURL }) => {
    const { ctx, page } = await open("admin", 1440, baseURL)
    await page.goto("/dashboard/chatrooms", { waitUntil: "networkidle" })
    const card = main(page).locator("section", { has: page.getByRole("heading", { name: roomTitle }) })
    const inside = await card.locator("dt", { hasText: /^inside$/ }).locator("xpath=following-sibling::dd").innerText()
    expect(inside).toMatch(/^\d+$/)
    await page.goto("/dashboard/reports", { waitUntil: "networkidle" })
    for (const name of ["Download Ratings CSV", "Download Organisations CSV", "Download Moderation CSV"]) {
      await expect(main(page).getByRole("button", { name })).toBeVisible()
    }
    await ctx.close()
  })
})
