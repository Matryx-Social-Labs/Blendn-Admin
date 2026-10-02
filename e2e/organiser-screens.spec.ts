import { test, expect, chromium, type Browser, type Page } from "@playwright/test"

import type { RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The organiser's screens on the design kit (step 15), driven in a real
 * browser against the seed.
 *
 * What only a browser sees: that the overview's panels render in the kit's
 * order with a row per upcoming event, that the Events list's tabs switch and
 * count, that the page draws no second Create button beside the top bar's,
 * and that axe finds nothing serious inside `main` at a phone's width and a
 * desktop's.
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

/** Serious and critical axe findings inside `main`: the screen's, not the shell's. */
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

test("the organiser overview: setup, the last 30 days, and a row per upcoming event, clean under axe", async ({ baseURL }) => {
  const found: string[] = []
  for (const width of [375, 1440]) {
    const { ctx, page } = await open("organizer", width, baseURL)
    await page.goto("/dashboard", { waitUntil: "networkidle" })
    await expect(main(page).getByRole("heading", { level: 1, name: "Overview" })).toBeVisible()
    await expect(main(page).getByRole("heading", { name: "Last 30 days" })).toBeVisible()
    const comingUp = main(page).locator("section", { has: page.getByRole("heading", { name: "Coming up" }) })
    // The seed gives Nightshift Collective nights ahead; each is a link to its event.
    await expect(comingUp.locator('a[href^="/dashboard/events/"]').first()).toBeVisible()
    // The hosts' overview reads fixed windows, so it is offered no range control.
    await expect(main(page).getByRole("button", { name: "90d" })).toHaveCount(0)
    // Getting set up, from the seed's rows: Nightshift exists and has published;
    // it has verified no domain and invited nobody, so the panel is there.
    const setup = main(page).locator("section", { has: page.getByRole("heading", { name: "Getting set up" }) })
    await expect(setup.getByRole("link", { name: /^Set up Nightshift Collective \(done\)$/ })).toBeVisible()
    await expect(setup.getByRole("link", { name: /^Publish an event \(done\)$/ })).toBeVisible()
    await expect(setup.getByRole("link", { name: /\(to do\)$/ }).first()).toBeVisible()
    found.push(...(await axeMain(page)).map((v) => `overview@${width}: ${v}`))
    await ctx.close()
  }
  expect(found).toEqual([])
})

test("the Events list: Upcoming, Drafts and Past tabs with counts, no second Create button, clean under axe", async ({
  baseURL,
}) => {
  const found: string[] = []
  for (const width of [375, 1440]) {
    const { ctx, page } = await open("organizer", width, baseURL)
    await page.goto("/dashboard/events", { waitUntil: "networkidle" })
    const tabs = main(page).getByRole("tablist", { name: "Events by state" })
    await expect(tabs.getByRole("tab")).toHaveText([/^Upcoming · \d+$/, /^Drafts · \d+$/, /^Past · \d+$/])
    // An organiser's list names no creator: organizer@ is Arjun Rao in the seed
    // (scripts/test-accounts.ts), and every Nightshift night is his.
    await expect(main(page).getByText("Arjun Rao")).toHaveCount(0)
    // The top bar's pill is the one Create event; the page draws none of its own.
    await expect(main(page).getByRole("link", { name: "Create event" })).toHaveCount(0)
    await expect(main(page).getByRole("button", { name: "Create event" })).toHaveCount(0)

    // The seeded draft is in Drafts, and only there.
    await expect(main(page).getByRole("link", { name: /Diwali Rooftop/ })).toHaveCount(0)
    await tabs.getByRole("tab", { name: /^Drafts/ }).click()
    await expect(main(page).getByRole("link", { name: /Diwali Rooftop/ })).toBeVisible()
    await expect(main(page).getByText("Draft", { exact: true }).filter({ visible: true }).first()).toBeVisible()
    found.push(...(await axeMain(page)).map((v) => `events drafts@${width}: ${v}`))

    await tabs.getByRole("tab", { name: /^Past/ }).click()
    await expect(main(page).getByRole("link", { name: /Monsoon Flea Market/ })).toBeVisible()
    await ctx.close()
  }
  expect(found).toEqual([])
})
