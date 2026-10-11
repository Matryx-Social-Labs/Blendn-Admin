import { test, expect, chromium, type Browser, type Page } from "@playwright/test"

import { statePathFor } from "./global-setup"

/**
 * The admin's decision screens on the kit (step 18, part A): the overview,
 * the moderation queues, the three claim queues, creative review and
 * applications. Each at a phone's width, a tablet's and a desktop's: one h1,
 * the kit's pieces, nothing wider than the viewport, and nothing serious or
 * critical under axe inside `main`.
 *
 * The measured figures are printed as one line per screen and width
 * (`[measure] …`), because they are reported, not only asserted.
 */

let browser: Browser
test.beforeAll(async () => {
  browser = await chromium.launch()
})
test.afterAll(async () => {
  await browser.close()
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

/** How far the page is wider than its viewport, in px; 0 is the only right answer. */
const overflowPx = (page: Page) =>
  page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth))

const main = (page: Page) => page.getByRole("main")

/** The queue switch every moderation and claims screen carries, with a count on each tab. */
async function queueTabs(page: Page, nav: string, tabs: string[], active: string) {
  const bar = main(page).getByRole("navigation", { name: nav })
  for (const tab of tabs) await expect(bar.getByRole("link", { name: new RegExp(`^${tab} · \\d+$`) })).toBeVisible()
  await expect(bar.getByRole("link", { name: new RegExp(`^${active} · \\d+$`) })).toHaveAttribute("aria-current", "page")
}

const SCREENS: Array<{ path: string; h1: string; check: (page: Page) => Promise<void> }> = [
  {
    path: "/dashboard",
    h1: "Overview",
    check: async (page) => {
      for (const name of ["The loop", "Turn-up", "Supply", "Cities"]) {
        await expect(main(page).getByRole("heading", { name, exact: true })).toBeVisible()
      }
      await expect(main(page).getByText("The stages after checked in need verified attendance")).toBeVisible()
    },
  },
  {
    path: "/dashboard/moderation",
    h1: "Moderation",
    check: (page) => queueTabs(page, "Moderation queue", ["Flags", "Reports"], "Flags"),
  },
  {
    path: "/dashboard/moderation/reports",
    h1: "Reports",
    check: async (page) => {
      await queueTabs(page, "Moderation queue", ["Flags", "Reports"], "Reports")
      // A card per report, or the empty state — never the old table.
      await expect(main(page).getByRole("table")).toHaveCount(0)
    },
  },
  { path: "/dashboard/claims", h1: "Claims", check: (page) => queueTabs(page, "Claim queue", ["Events", "Venues", "Brands"], "Events") },
  { path: "/dashboard/claims/venues", h1: "Claims", check: (page) => queueTabs(page, "Claim queue", ["Events", "Venues", "Brands"], "Venues") },
  { path: "/dashboard/claims/brands", h1: "Claims", check: (page) => queueTabs(page, "Claim queue", ["Events", "Venues", "Brands"], "Brands") },
  {
    path: "/dashboard/creative-review",
    h1: "Creative review",
    check: async (page) => {
      const preview = main(page).getByText(/^Sponsored · /)
      await expect(preview.first().or(main(page).getByText("Nothing waiting"))).toBeVisible()
    },
  },
  {
    path: "/dashboard/onboarding",
    h1: "Applications",
    check: async (page) => {
      const approve = main(page).getByRole("button", { name: "Approve & create the account" })
      await expect(approve.first().or(main(page).getByText("Nothing to review"))).toBeVisible()
    },
  },
]

test("each decision screen: one h1, the kit's pieces, no sideways scroll, nothing serious under axe, at 375, 768 and 1440", async ({ baseURL }) => {
  test.setTimeout(360_000)
  const found: string[] = []
  for (const width of [375, 768, 1440]) {
    const ctx = await browser.newContext({ storageState: statePathFor("admin"), viewport: { width, height: 900 }, baseURL })
    const page = await ctx.newPage()
    for (const screen of SCREENS) {
      await page.goto(screen.path, { waitUntil: "networkidle" })
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(screen.h1)
      await screen.check(page)
      const overflow = await overflowPx(page)
      const axe = await axeMain(page)
      const h1s = await page.getByRole("heading", { level: 1 }).count()
      console.log(`[measure] ${screen.path} @${width}: axe ${axe.length}, overflow ${overflow}px, h1 ${h1s}`)
      if (overflow > 1) found.push(`${screen.path}@${width}: ${overflow}px wider than the viewport`)
      if (h1s !== 1) found.push(`${screen.path}@${width}: ${h1s} h1`)
      found.push(...axe.map((v) => `${screen.path}@${width}: ${v}`))
    }
    await ctx.close()
  }
  expect(found).toEqual([])
})

test("a decline waits for its reason: ten characters before it can be sent", async ({ baseURL }) => {
  const ctx = await browser.newContext({ storageState: statePathFor("admin"), viewport: { width: 1440, height: 900 }, baseURL })
  const page = await ctx.newPage()
  await page.goto("/dashboard/onboarding", { waitUntil: "networkidle" })
  const decline = main(page).getByRole("button", { name: "Decline", exact: true })
  test.skip((await decline.count()) === 0, "no application waiting in this world")
  await decline.first().click()
  const send = main(page).getByRole("button", { name: "Send decline" })
  await expect(send).toBeDisabled()
  await main(page).getByRole("textbox").first().fill("Too short")
  await expect(send).toBeDisabled()
  await expect(main(page).getByText("1 more character needed.")).toBeVisible()
  // Back, without sending: this test writes nothing.
  await main(page).getByRole("button", { name: "Back" }).click()
  await expect(send).toHaveCount(0)
  await ctx.close()
})
