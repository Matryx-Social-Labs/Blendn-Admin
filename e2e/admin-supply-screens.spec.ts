import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { MATRIX_MARKERS } from "../scripts/seed-matrix-markers"
import type { RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The admin's supply, people and setup screens on the kit (step 18, part B):
 * each at a phone's width, a tablet's and a desktop's, with one h1, no
 * sideways scroll, nothing axe calls serious inside `main`, and the kit piece
 * that carries the screen's memorable detail. Settings is every role's, so it
 * is opened as each.
 *
 * The numbers are printed as well as asserted — the measured table is what the
 * step reports (TQ-X09), and a pass alone does not say how close anything was.
 */

let browser: Browser
test.beforeAll(async () => {
  browser = await chromium.launch()
})
test.afterAll(async () => {
  await browser.close()
})

const WIDTHS = [375, 768, 1440] as const

async function axeMain(page: Page): Promise<{ all: number; serious: string[] }> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })
  return page.evaluate(async () => {
    type Axe = { run: (...a: unknown[]) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> }
    const res = await (window as unknown as { axe: Axe }).axe.run({ include: [["main"]] }, { resultTypes: ["violations"] })
    return {
      all: res.violations.length,
      serious: res.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    }
  })
}

/** Pixels the page scrolls sideways. Zero is the only right answer on a dashboard. */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

const main = (page: Page) => page.getByRole("main")

interface Screen {
  path: string
  h1: string
  /** The kit piece that carries the screen's memorable detail. */
  check: (page: Page) => Promise<void>
}

async function screens(): Promise<Screen[]> {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
  const [organiser, venueOwner] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { email: "organizer@blendn.app" }, select: { id: true, name: true } }),
    db.user.findUniqueOrThrow({ where: { email: "venue.owner@blendn.app" }, select: { id: true, name: true } }),
  ]).finally(() => db.$disconnect())

  return [
    {
      path: "/dashboard/events",
      h1: "Events",
      check: async (page) => {
        await expect(page.getByRole("link", { name: "Curate from a listing" })).toBeVisible()
        await expect(main(page).getByText("Listed by us").first()).toBeVisible()
      },
    },
    {
      path: "/dashboard/events/curate",
      h1: "Curation",
      check: async (page) => {
        await expect(main(page).getByText("Likely a wrong pin", { exact: true })).toBeVisible()
        await expect(main(page).getByRole("heading", { name: "Add an event from a public listing" })).toBeVisible()
        await expect(main(page).getByText("re-pin", { exact: true })).toBeVisible()
      },
    },
    {
      path: "/dashboard/organisers",
      h1: "Organisers",
      check: async (page) => {
        await expect(main(page).getByText(/never published/)).toBeVisible()
        await expect(main(page).getByText("never", { exact: true }).first()).toBeVisible()
      },
    },
    {
      path: `/dashboard/organisers/${organiser.id}`,
      h1: organiser.name ?? "Unnamed organiser",
      check: async (page) => {
        await expect(main(page).getByRole("heading", { name: "Events" })).toBeVisible()
      },
    },
    {
      path: "/dashboard/venue-owners",
      h1: "Venue owners",
      check: async (page) => {
        await expect(main(page).getByText("claim pending", { exact: true }).first()).toBeVisible()
      },
    },
    {
      path: `/dashboard/venue-owners/${venueOwner.id}`,
      h1: venueOwner.name ?? "Unnamed venue owner",
      check: async (page) => {
        await expect(main(page).getByRole("heading", { name: "Events" })).toBeVisible()
      },
    },
    {
      path: "/dashboard/venues",
      h1: "Venues",
      check: async (page) => {
        await expect(main(page).getByText(/unclaimed · 1 claim/).first()).toBeVisible()
      },
    },
    {
      path: "/dashboard/organisations",
      h1: "Organisations",
      check: async (page) => {
        await expect(main(page).getByText("suspended", { exact: true }).first()).toBeVisible()
      },
    },
    {
      path: "/dashboard/users",
      h1: "Users",
      check: async (page) => {
        await expect(main(page).getByText(/accounts?$/).first()).toBeVisible()
      },
    },
    {
      path: "/dashboard/leads?status=all",
      h1: "Leads",
      check: async (page) => {
        // The pills carry their counts (the kit's Seg).
        await expect(main(page).getByRole("button", { name: /^All \d+$/ })).toBeVisible()
      },
    },
    {
      path: "/dashboard/sponsors",
      h1: "Brands",
      check: async (page) => {
        await expect(main(page).getByRole("heading", { name: "All brands" })).toBeVisible()
      },
    },
    {
      path: "/dashboard/categories",
      h1: "Categories",
      check: async (page) => {
        await expect(main(page).getByRole("heading", { name: "Music" })).toBeVisible()
        await expect(main(page).getByText(MATRIX_MARKERS.category)).toBeVisible()
      },
    },
    {
      path: "/dashboard/amenities",
      h1: "Amenities",
      check: async (page) => {
        await expect(main(page).getByRole("heading", { name: "Offered" })).toBeVisible()
        await expect(main(page).getByRole("heading", { name: "Add an amenity" })).toBeVisible()
      },
    },
    {
      path: "/dashboard/settings",
      h1: "Settings",
      check: async (page) => {
        for (const name of ["Profile", "Password", "Sessions"]) {
          await expect(main(page).getByRole("heading", { name })).toBeVisible()
        }
      },
    },
  ]
}

async function measure(account: RoleKey, list: Screen[], baseURL: string | undefined) {
  const rows: string[] = []
  const wrong: string[] = []
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ storageState: statePathFor(account), viewport: { width, height: 900 }, baseURL })
    const page = await ctx.newPage()
    for (const screen of list) {
      await page.goto(screen.path, { waitUntil: "networkidle" })
      const h1s = await page.getByRole("heading", { level: 1 }).count()
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(screen.h1)
      await screen.check(page)
      const px = await overflow(page)
      const axe = await axeMain(page)
      rows.push(`${account.padEnd(9)} ${screen.path.replace(/[0-9a-z]{25}$/, "[id]").padEnd(34)} ${String(width).padEnd(5)} axe ${axe.serious.length} serious / ${axe.all} total · overflow ${px}px · h1 ${h1s}`)
      if (h1s !== 1) wrong.push(`${screen.path}@${width}: ${h1s} h1`)
      if (px > 0) wrong.push(`${screen.path}@${width}: ${px}px sideways`)
      wrong.push(...axe.serious.map((v) => `${screen.path}@${width}: ${v}`))
    }
    await ctx.close()
  }
  return { rows, wrong }
}

test("the admin's supply, people and setup screens at 375, 768 and 1440", async ({ baseURL }) => {
  test.setTimeout(420_000)
  const { rows, wrong } = await measure("admin", await screens(), baseURL)
  console.log("measured (account path width):\n" + rows.map((r) => "  " + r).join("\n"))
  expect(wrong).toEqual([])
})

test("Settings is every role's, and the same screen for each", async ({ baseURL }) => {
  test.setTimeout(240_000)
  const settings = (await screens()).filter((s) => s.path === "/dashboard/settings")
  const all: string[] = []
  const wrong: string[] = []
  for (const role of ["organizer", "venue", "sponsor"] as const) {
    const r = await measure(role, settings, baseURL)
    all.push(...r.rows)
    wrong.push(...r.wrong)
  }
  console.log("measured (account path width):\n" + all.map((r) => "  " + r).join("\n"))
  expect(wrong).toEqual([])
})

test("a lead from an address that applied says so in its drawer", async ({ baseURL }) => {
  const ctx = await browser.newContext({ storageState: statePathFor("admin"), viewport: { width: 1440, height: 900 }, baseURL })
  const page = await ctx.newPage()
  // `all`, not the seeded `contacted`: the seed leaves the lead alone once somebody has moved it.
  await page.goto("/dashboard/leads?status=all", { waitUntil: "networkidle" })
  // The row's way in is its first cell's link, as on every DataTable.
  await main(page).getByRole("row", { name: new RegExp(MATRIX_MARKERS.lead) }).getByRole("link").click()
  const drawer = page.getByRole("dialog", { name: "Lead detail" })
  await expect(drawer.getByText("Already applied")).toBeVisible()
  await expect(drawer.getByText("The Humming Tree — application is")).toBeVisible()
  await ctx.close()
})
