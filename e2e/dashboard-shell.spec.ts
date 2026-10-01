import { test, expect, chromium, type Browser, type Page } from "@playwright/test"

import { visibleNavFor } from "../lib/dashboard-nav"
import { ROLE_ACCOUNTS, type RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The dashboard shell (step 14), for every role, in a real browser.
 *
 * What a unit test cannot see: that the sidebar is 248px and flush, that the
 * top bar is 60px, that a phone gets a sheet instead of a sidebar, that the
 * page has exactly one `h1` and it is inside `main`, that the last crumb and
 * the `h1` agree once the client has rendered, and that the Create event pill
 * appears for exactly the accounts `mayCreateEvents` allows.
 *
 * The cheap half runs on every PR: one page per role at each width. The
 * `@sweep` half visits every nav destination for every role at all three
 * widths, nightly or under `full-e2e`, like `responsive` and `role-surfaces`.
 */

const ROLES: RoleKey[] = ["admin", "organizer", "venue", "sponsor"]
const WIDTHS = [375, 768, 1440]

/** Seeded: the admin and the two hosts in live organisations may create; the sponsor and the stranded organiser may not. */
const MAY_CREATE: Record<string, boolean> = {
  admin: true,
  organizer: true,
  venue: true,
  sponsor: false,
  outsider: false,
}

let browser: Browser
test.beforeAll(async () => {
  browser = await chromium.launch()
})
test.afterAll(async () => {
  await browser.close()
})

async function open(role: RoleKey, width: number, baseURL: string | undefined) {
  const ctx = await browser.newContext({
    storageState: statePathFor(role),
    viewport: { width, height: 900 },
    baseURL,
  })
  return { ctx, page: await ctx.newPage() }
}

/** One h1 on the page, inside main, and the breadcrumb trail ends on its words. */
async function assertHeading(page: Page) {
  await expect(page.locator("h1")).toHaveCount(1)
  await expect(page.locator("main h1")).toHaveCount(1)
  const title = (await page.locator("main h1").innerText()).trim()
  await expect(page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]')).toHaveText(title)
}

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test.describe("the shell", () => {
  for (const role of [...ROLES, "outsider" as RoleKey]) {
    test(`${role}: flush 248px sidebar, 60px top bar, one h1 in main, the pill only if it may create`, async ({
      baseURL,
    }) => {
      const { ctx, page } = await open(role, 1440, baseURL)
      await page.goto("/dashboard", { waitUntil: "domcontentloaded" })
      await assertHeading(page)

      const sidebar = page.locator('[data-slot="sidebar-container"]')
      await expect(sidebar).toBeVisible()
      expect((await sidebar.boundingBox())!.width).toBe(248)

      const topbar = page.locator('header:has(nav[aria-label="Breadcrumb"])')
      expect((await topbar.boundingBox())!.height).toBe(60)

      // Never more than 1200px of content, however wide the window.
      expect((await page.locator("main").boundingBox())!.width).toBeLessThanOrEqual(1200)

      // The visible search field, with copy that never promises a host people.
      const search = topbar.getByRole("button", { name: /^Search events/ })
      await expect(search).toBeVisible()
      if (role !== "admin") await expect(search).not.toContainText("people")
      // It opens the existing palette, which promises what the field did.
      await search.click()
      const palette = page.getByRole("dialog", { name: "Search" })
      await expect(palette).toBeVisible()
      await expect(palette.getByRole("textbox", { name: "Search" })).toHaveAttribute(
        "placeholder",
        (await search.innerText()).replace("⌘K", "").trim()
      )
      await page.keyboard.press("Escape")
      await expect(palette).toBeHidden()

      const pill = topbar.locator('a[href="/dashboard/events/new"]')
      await expect(pill).toHaveCount(MAY_CREATE[role] ? 1 : 0)

      // The identity card names the organisation the first crumb names.
      const firstCrumb = (await page.locator('nav[aria-label="Breadcrumb"] li').first().innerText()).trim()
      await expect(sidebar).toContainText(firstCrumb)

      // Hosts get the kit's headings; nobody gets a heading over nothing.
      const account = ROLE_ACCOUNTS[role].role
      if (account !== "app_admin") {
        await expect(sidebar).not.toContainText(/Supply|People|Record|Setup/)
      }
      await ctx.close()
    })
  }

  test("a phone gets a sheet, not a sidebar, and nothing scrolls sideways", async ({ baseURL }) => {
    const { ctx, page } = await open("organizer", 375, baseURL)
    await page.goto("/dashboard", { waitUntil: "networkidle" })
    await expect(page.locator('[data-slot="sidebar-container"]')).toBeHidden()
    await assertHeading(page)
    expect(await overflow(page)).toBeLessThanOrEqual(1)

    await page.locator('button[data-sidebar="trigger"]').click()
    const sheet = page.locator('[data-mobile="true"]')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole("link", { name: "Attendees" })).toBeVisible()
    await ctx.close()
  })

  test("the top bar fits at every width: nothing is cut off", async ({ baseURL }) => {
    /*
     * The column clips (`overflow-x-clip`), so an over-full bar does not scroll
     * the page — it just loses its right edge. At 768 the first build lost the
     * account menu that way (crumbs drawn under the search field, the chevron
     * past the edge), and a page-overflow check cannot see it. The crumbs
     * themselves are allowed to truncate; the controls are not.
     */
    const bad: string[] = []
    for (const role of ["admin", "venue"] as RoleKey[]) {
      for (const width of [375, 768, 1024, 1440]) {
        const { ctx, page } = await open(role, width, baseURL)
        await page.goto("/dashboard/events", { waitUntil: "networkidle" })
        const boxes = await page.evaluate(() => {
          const bar = document.querySelector('header:has(nav[aria-label="Breadcrumb"])')!
          const kids = Array.from(bar.children)
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0)
          return {
            right: Math.max(...kids.map((r) => r.right)),
            barRight: bar.getBoundingClientRect().right,
          }
        })
        if (boxes.right > boxes.barRight + 1) bad.push(`${role}@${width}: cut off by ${boxes.right - boxes.barRight}px`)
        await ctx.close()
      }
    }
    expect(bad).toEqual([])
  })

  test("axe finds nothing serious or critical in the shell", async ({ baseURL }) => {
    /*
     * Scoped to what this step drew — the top bar, the sidebar and the page
     * header — so a finding here is the shell's, not a screen's. The screens
     * are checked as they move to the kit (steps 15–18).
     */
    const found: string[] = []
    for (const role of ROLES) {
      for (const width of [375, 1440]) {
        const { ctx, page } = await open(role, width, baseURL)
        await page.goto("/dashboard", { waitUntil: "networkidle" })
        await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })
        const violations = await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run: (...a: unknown[]) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe
          const res = await axe.run(
            {
              include: [
                ['header:has(nav[aria-label="Breadcrumb"])'],
                ['[data-slot="sidebar-container"]'],
                ["main > div:first-child"],
              ],
            },
            { resultTypes: ["violations"] }
          )
          return res.violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
        })
        found.push(...violations.map((v) => `${role}@${width}: ${v}`))
        await ctx.close()
      }
    }
    expect(found).toEqual([])
  })
})

test("@sweep every role's every destination, at 375, 768 and 1440: one h1 in main, no sideways scroll", async ({
  baseURL,
}) => {
  test.setTimeout(900_000)
  const failures: string[] = []
  let measured = 0

  for (const role of ROLES) {
    const urls = visibleNavFor(ROLE_ACCOUNTS[role].role).map((i) => i.url)
    for (const width of WIDTHS) {
      const { ctx, page } = await open(role, width, baseURL)
      for (const url of urls) {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
        if (new URL(page.url()).pathname !== url) continue
        measured++
        const h1 = await page.locator("h1").count()
        const inMain = await page.locator("main h1").count()
        if (h1 !== 1 || inMain !== 1) failures.push(`${role} ${width}px ${url}: ${h1} h1, ${inMain} in main`)
        const over = await overflow(page)
        if (over > 1) failures.push(`${role} ${width}px ${url}: ${over}px sideways`)
      }
      await ctx.close()
    }
  }

  expect(failures).toEqual([])
  // Floor: four roles' destinations at three widths. A sweep that visited
  // nothing would otherwise pass.
  expect(measured).toBeGreaterThan(80)
})
