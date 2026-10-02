import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { visibleNavFor } from "../lib/dashboard-nav"
import { ownsHeader } from "../lib/dashboard-route-content"
import { ROLE_ACCOUNTS, type PersonaKey, type RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The dashboard shell (step 14), for every role, in a real browser.
 *
 * What a unit test cannot see: the sidebar is 248px and flush, the top bar is
 * 60px, a phone gets a sheet that closes when you follow a link, a collapsed
 * sidebar takes no focus, ⌘K opens a real dialog over the whole page, the page
 * has exactly one `h1` and it is inside `main`, the tab is titled like the
 * page, and the Create event pill appears for exactly the accounts
 * `mayCreateEvents` allows.
 *
 * The cheap half runs on every PR. The `@sweep` half visits every nav
 * destination for every role at all three widths, nightly or under the
 * `full-e2e` label, like `responsive` and `role-surfaces`.
 */

const ROLES = ["admin", "organizer", "venue", "sponsor"] as const satisfies readonly RoleKey[]
const WIDTHS = [375, 768, 1440]
const TITLE_SUFFIX = " | Blend'n Admin"

/** Seeded: the admin and the two hosts in live organisations may create; the sponsor and the stranded organiser may not. */
const MAY_CREATE: Record<string, boolean> = {
  admin: true,
  organizer: true,
  venue: true,
  sponsor: false,
  outsider: false,
  multiOrg: true,
  partSuspended: true,
  onlySuspended: false,
  secondVenueOwner: true,
}

/** The identity card's first line, per account — and the seed's other organisations, which it must not name. */
const CARD: Record<string, { org: string; sub: RegExp }> = {
  admin: { org: "Blend'n", sub: /^Platform$/i },
  organizer: { org: "Nightshift Collective", sub: /^Organiser$/i },
  venue: { org: "Indiranagar Hospitality Group", sub: /^Venue owner$/i },
  sponsor: { org: "Blue Tokai Coffee Roasters", sub: /^Sponsor$/i },
  outsider: { org: "No organisation", sub: /^Organiser$/i },
  multiOrg: { org: "Lantern Lane Events", sub: /^Organiser · \+1 more$/i },
  partSuspended: { org: "Sunday Supper Club", sub: /^Organiser$/i },
  onlySuspended: { org: "Retired Rooms Co", sub: /^Organiser$/i },
  secondVenueOwner: { org: "Koramangala Social House", sub: /^Venue owner$/i },
}
// "Blend'n" is also the wordmark beside the logo on every sidebar, so it is
// checked on the card itself, not by absence from the sidebar.
const ALL_ORGS = [...new Set(Object.values(CARD).map((c) => c.org))].filter((o) => o !== "Blend'n")

/** The headings each role's sidebar draws, in order. */
const NAV_GROUPS: Record<(typeof ROLES)[number], string[]> = {
  admin: ["Needs a decision", "Supply", "People", "Commercial", "Setup", "Record"],
  organizer: ["Community", "Organisation"],
  venue: ["Community", "Organisation"],
  sponsor: ["Organisation"],
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
let browser: Browser
let ids: { event: string; pastEvent: string; venue: string }

test.beforeAll(async () => {
  browser = await chromium.launch()
  const [event, pastEvent, venue] = await Promise.all([
    db.events.findFirst({ where: { slug: "founders-filter-coffee", deleted_at: null }, select: { id: true } }),
    db.events.findFirst({ where: { slug: "monsoon-flea-market", deleted_at: null }, select: { id: true } }),
    db.venues.findFirst({ where: { name: "The Humming Tree", deleted_at: null }, select: { id: true } }),
  ])
  if (!event || !pastEvent || !venue) throw new Error("seeded event/venue missing — run seed:qa --apply")
  ids = { event: event.id, pastEvent: pastEvent.id, venue: venue.id }
})
test.afterAll(async () => {
  await browser.close()
  await db.$disconnect()
})

async function open(account: RoleKey | PersonaKey, width: number, baseURL: string | undefined) {
  const ctx = await browser.newContext({
    storageState: statePathFor(account),
    viewport: { width, height: 900 },
    baseURL,
  })
  return { ctx, page: await ctx.newPage() }
}

const topbar = (page: Page) => page.locator('header:has(nav[aria-label="Breadcrumb"])')
const sidebar = (page: Page) => page.locator('[data-slot="sidebar-container"]')
const trigger = (page: Page) => page.locator('button[data-sidebar="trigger"]')

/**
 * One h1 on the page, inside main, and the tab says the same.
 *
 * A layout-named route: the last crumb is the h1's word, and the title is it
 * plus the product. An owned route (`OWNED_HEADERS`): the h1 is the record's
 * name, inside main's first element — the page renders it first — and the
 * title carries it.
 */
async function assertHeading(page: Page) {
  await expect(page.locator("h1")).toHaveCount(1)
  await expect(page.locator("main h1")).toHaveCount(1)
  const title = (await page.locator("main h1").innerText()).trim()
  const owned = ownsHeader(new URL(page.url()).pathname)
  if (owned) {
    await expect(page.locator("main > :first-child h1")).toHaveCount(1)
    await expect(page).toHaveTitle(new RegExp(escape(title)))
  } else {
    await expect(page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]')).toHaveText(title)
    await expect(page).toHaveTitle(title + TITLE_SUFFIX)
  }
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

/** Clicks once the page has hydrated: a click before React attaches is lost. */
async function clickUntil(page: Page, target: ReturnType<Page["locator"]>, then: () => Promise<void>) {
  await expect(async () => {
    await target.click()
    await then()
  }).toPass({ timeout: 15_000 })
}

test.describe("the shell", () => {
  for (const role of [...ROLES, "outsider"] as const) {
    test(`${role}: flush 248px sidebar, 60px bar, its own org on the card, one h1, the pill only if it may create`, async ({
      baseURL,
    }) => {
      const { ctx, page } = await open(role, 1440, baseURL)
      await page.goto("/dashboard", { waitUntil: "networkidle" })
      await assertHeading(page)

      await expect(sidebar(page)).toBeVisible()
      expect((await sidebar(page).boundingBox())!.width).toBe(248)
      expect((await topbar(page).boundingBox())!.height).toBe(60)
      // Never more than 1200px of content, however wide the window.
      expect((await page.locator("main").boundingBox())!.width).toBeLessThanOrEqual(1200)

      // The card names this account's organisation and no other.
      const card = sidebar(page).locator("nav[aria-label='Dashboard'] [data-slot='org-card']")
      await expect(card.locator("[data-slot='org-card-name']")).toHaveText(CARD[role].org)
      await expect(card.locator("[data-slot='org-card-role']")).toHaveText(CARD[role].sub)
      for (const other of ALL_ORGS.filter((o) => o !== CARD[role].org)) {
        await expect(sidebar(page)).not.toContainText(other)
      }
      await expect(page.locator('nav[aria-label="Breadcrumb"] li').first()).toHaveText(CARD[role].org)

      // Its headings, in order: the kit's for hosts, the six for an admin.
      if (role !== "outsider") {
        await expect(sidebar(page).locator('[data-slot="nav-group-label"]')).toHaveText(NAV_GROUPS[role])
      }

      const search = topbar(page).getByRole("button", { name: /^Search events/ })
      await expect(search).toBeVisible()
      await expect(search).toHaveAttribute("aria-haspopup", "dialog")
      await expect(search).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K")
      // ⌘K on a Mac, Ctrl K elsewhere — whichever this browser is.
      const apple = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent))
      await expect(search.locator("kbd")).toHaveText(apple ? "⌘K" : "Ctrl K")
      if (role !== "admin") await expect(search).not.toContainText("people")

      await expect(topbar(page).locator('a[href="/dashboard/events/new"]')).toHaveCount(MAY_CREATE[role] ? 1 : 0)
      await ctx.close()
    })
  }

  for (const persona of ["multiOrg", "partSuspended", "onlySuspended", "secondVenueOwner"] as const) {
    test(`${persona}: the card names the right organisation, and a suspension is said`, async ({ baseURL }) => {
      const { ctx, page } = await open(persona, 1440, baseURL)
      await page.goto("/dashboard", { waitUntil: "networkidle" })
      const card = sidebar(page).locator("[data-slot='org-card']")
      await expect(card.locator("[data-slot='org-card-name']")).toHaveText(CARD[persona].org)
      await expect(card.locator("[data-slot='org-card-role']")).toHaveText(CARD[persona].sub)
      await expect(topbar(page).locator('a[href="/dashboard/events/new"]')).toHaveCount(MAY_CREATE[persona] ? 1 : 0)
      const notice = page.locator("main [role='status']").filter({ hasText: "is suspended" })
      if (persona === "partSuspended" || persona === "onlySuspended") {
        await expect(notice).toContainText("Retired Rooms Co is suspended.")
      } else {
        await expect(notice).toHaveCount(0)
      }
      await ctx.close()
    })
  }

  test("⌘K is a dialog over the whole page: trapped, named, announced, and focus comes home", async ({ baseURL }) => {
    const { ctx, page } = await open("organizer", 1440, baseURL)
    await page.goto("/dashboard", { waitUntil: "networkidle" })
    const search = topbar(page).getByRole("button", { name: /^Search events/ })
    const dialog = page.getByRole("dialog", { name: "Search" })
    await clickUntil(page, search, () => expect(dialog).toBeVisible({ timeout: 1000 }))

    // The backdrop is the viewport, not the 60px bar it used to be trapped in.
    const overlay = await page.locator('[data-slot="command-palette-overlay"]').boundingBox()
    expect(overlay).toEqual({ x: 0, y: 0, width: 1440, height: 900 })

    const box = dialog.getByRole("combobox", { name: "Search" })
    await expect(box).toBeFocused()
    await expect(box).toHaveAttribute("aria-controls", "command-palette-results")
    await expect(page.locator("#command-palette-results")).toHaveAttribute("role", "listbox")

    await box.fill("founders")
    const status = dialog.locator("[role='status']")
    await expect(status).toHaveText(/^1 result\.$/)
    await expect(box).toHaveAttribute("aria-expanded", "true")
    const activeId = await box.getAttribute("aria-activedescendant")
    await expect(page.locator(`#${activeId}`)).toHaveAttribute("aria-selected", "true")
    await expect(page.locator(`#${activeId}`)).toContainText("Founders & Filter Coffee")

    // Focus stays inside however far you tab.
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab")
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)

    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(search).toBeFocused()

    // And the keyboard opens it from anywhere.
    await page.keyboard.press("ControlOrMeta+k")
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")
    await ctx.close()
  })

  test("a phone gets a sheet that closes when you go somewhere, and on Escape", async ({ baseURL }) => {
    const { ctx, page } = await open("organizer", 375, baseURL)
    await page.goto("/dashboard", { waitUntil: "networkidle" })
    await expect(sidebar(page)).toBeHidden()
    await assertHeading(page)
    expect(await overflow(page)).toBeLessThanOrEqual(1)

    const sheet = page.locator('[data-mobile="true"]')
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "false")
    await clickUntil(page, trigger(page), () => expect(sheet).toBeVisible({ timeout: 1000 }))
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "true")

    await sheet.getByRole("link", { name: "Attendees" }).click()
    await expect(page).toHaveURL(/\/dashboard\/attendees$/)
    await expect(sheet).toBeHidden()
    await assertHeading(page)

    await trigger(page).click()
    await expect(sheet).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(sheet).toBeHidden()
    await expect(trigger(page)).toBeFocused()
    await ctx.close()
  })

  test("at the 767/768 seam there is exactly one nav surface", async ({ baseURL }) => {
    // Below 768 the sheet, at 768 and up the sidebar — never both, never neither.
    for (const [width, desktop] of [[767, false], [768, true]] as const) {
      const { ctx, page } = await open("organizer", width, baseURL)
      await page.goto("/dashboard", { waitUntil: "networkidle" })
      if (desktop) {
        await expect(sidebar(page)).toBeVisible()
        await expect(page.locator('[data-mobile="true"]')).toHaveCount(0)
      } else {
        await expect(sidebar(page)).toBeHidden()
        await clickUntil(page, trigger(page), () => expect(page.locator('[data-mobile="true"]')).toBeVisible({ timeout: 1000 }))
        await expect(sidebar(page)).toBeHidden()
      }
      await ctx.close()
    }
  })

  for (const width of [768, 1440]) {
    test(`at ${width} the sidebar collapses out of the tab order, and comes back`, async ({ baseURL }) => {
      const { ctx, page } = await open("organizer", width, baseURL)
      await page.goto("/dashboard", { waitUntil: "networkidle" })
      await expect(trigger(page)).toHaveAttribute("aria-expanded", "true")
      await expect(trigger(page)).toHaveAttribute("aria-controls", "app-sidebar")

      await clickUntil(page, trigger(page), () => expect(trigger(page)).toHaveAttribute("aria-expanded", "false", { timeout: 1000 }))
      await expect(sidebar(page)).toHaveAttribute("inert", "")
      await expect(async () => {
        const b = (await sidebar(page).boundingBox())!
        expect(b.x + b.width).toBeLessThanOrEqual(0)
      }).toPass()

      await trigger(page).click()
      await expect(trigger(page)).toHaveAttribute("aria-expanded", "true")
      await expect(sidebar(page)).not.toHaveAttribute("inert", /.*/)
      await expect(async () => expect((await sidebar(page).boundingBox())!.x).toBe(0)).toPass()
      await ctx.close()
    })
  }

  test("the first Tab is a skip link, and it lands on main", async ({ baseURL }) => {
    const { ctx, page } = await open("organizer", 1440, baseURL)
    await page.goto("/dashboard", { waitUntil: "networkidle" })
    await page.keyboard.press("Tab")
    const skip = page.getByRole("link", { name: "Skip to content" })
    await expect(skip).toBeFocused()
    await expect(skip).toBeVisible()
    await page.keyboard.press("Enter")
    await expect(page.locator("main#main")).toBeFocused()
    await ctx.close()
  })

  test("after a soft navigation the h1, the crumb and the tab follow", async ({ baseURL }) => {
    const { ctx, page } = await open("organizer", 1440, baseURL)
    await page.goto("/dashboard", { waitUntil: "networkidle" })
    await sidebar(page).getByRole("link", { name: "Attendees" }).click()
    await expect(page).toHaveURL(/\/dashboard\/attendees$/)
    await expect(page.locator("main h1")).toHaveText("Attendees")
    await assertHeading(page)
    await sidebar(page).getByRole("link", { name: "Team" }).click()
    await expect(page.locator("main h1")).toHaveText("Team")
    await assertHeading(page)
    await ctx.close()
  })

  test("deep routes: one h1, in main, for admin and organiser — and records are named by name", async ({ baseURL }) => {
    test.setTimeout(240_000)
    const deep = [
      "/dashboard/events/new",
      `/dashboard/events/${ids.event}`,
      `/dashboard/events/${ids.event}/edit`,
      `/dashboard/events/${ids.event}/messaging`,
      `/dashboard/events/${ids.pastEvent}/feedback`,
      `/dashboard/venues/${ids.venue}`,
      "/dashboard/venues/new",
      "/dashboard/claims/venues",
      "/dashboard/moderation/reports",
    ]
    const named: string[] = []
    for (const role of ["admin", "organizer"] as const) {
      const { ctx, page } = await open(role, 1440, baseURL)
      for (const url of deep) {
        await page.goto(url, { waitUntil: "networkidle" })
        await assertHeading(page)
        if (new URL(page.url()).pathname === `/dashboard/events/${ids.event}`) {
          named.push(`${role}: ${await page.locator("main h1").innerText()}`)
        }
      }
      await ctx.close()
    }
    // The event page is called by its title, for both — not "Event".
    expect(named).toEqual(["admin: Founders & Filter Coffee", "organizer: Founders & Filter Coffee"])
  })

  test("the top bar fits at every width: nothing is cut off", async ({ baseURL }) => {
    /*
     * The column clips (`overflow-x-clip`), so an over-full bar does not scroll
     * the page — it just loses its right edge. At 768 the first build lost the
     * account menu that way, and a page-overflow check cannot see it. The
     * crumbs themselves may truncate; the controls may not.
     */
    const bad: string[] = []
    for (const role of ["admin", "venue"] as const) {
      for (const width of [375, 768, 1024, 1440]) {
        const { ctx, page } = await open(role, width, baseURL)
        await page.goto("/dashboard/events", { waitUntil: "networkidle" })
        const boxes = await page.evaluate(() => {
          const bar = document.querySelector('header:has(nav[aria-label="Breadcrumb"])')!
          const kids = Array.from(bar.children)
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0)
          return { right: Math.max(...kids.map((r) => r.right)), barRight: bar.getBoundingClientRect().right }
        })
        if (boxes.right > boxes.barRight + 1) bad.push(`${role}@${width}: cut off by ${boxes.right - boxes.barRight}px`)
        await ctx.close()
      }
    }
    expect(bad).toEqual([])
  })

  test("the bar and the publish rail stay put, and the rail clears the bar", async ({ baseURL }) => {
    const { ctx, page } = await open("organizer", 1440, baseURL)
    await page.goto("/dashboard/events/new", { waitUntil: "networkidle" })
    await page.mouse.wheel(0, 1600)
    await expect(async () => expect(await page.evaluate(() => scrollY)).toBeGreaterThan(400)).toPass()
    const pos = await page.evaluate(() => ({
      bar: document.querySelector('header:has(nav[aria-label="Breadcrumb"])')!.getBoundingClientRect(),
      rail: document.querySelector('aside[aria-label="Publish"]')!.getBoundingClientRect(),
      side: document.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect(),
    }))
    expect(pos.bar.top).toBe(0)
    expect(pos.side.top).toBe(0)
    expect(pos.rail.top).toBeGreaterThanOrEqual(pos.bar.bottom)
    await ctx.close()
  })

  test("axe finds nothing serious or critical in the shell — closed, with the sheet open, with ⌘K open", async ({
    baseURL,
  }) => {
    /*
     * Scoped to what this step drew — the top bar, the sidebar or its sheet,
     * the page header, the palette — so a finding here is the shell's, not a
     * screen's. The screens are checked as they move to the kit (steps 15–18).
     */
    const run = (page: Page, include: string[][]) =>
      page.evaluate(async (inc) => {
        type Axe = { run: (...a: unknown[]) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> }
        const res = await (window as unknown as { axe: Axe }).axe.run({ include: inc }, { resultTypes: ["violations"] })
        return res.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
      }, include)
    const axePath = require.resolve("axe-core/axe.min.js")
    const shell = [['header:has(nav[aria-label="Breadcrumb"])'], ['[data-slot="sidebar-container"]'], ["main > div:first-child"]]

    const found: string[] = []
    for (const role of ROLES) {
      for (const width of [375, 1440]) {
        const { ctx, page } = await open(role, width, baseURL)
        await page.goto("/dashboard", { waitUntil: "networkidle" })
        await page.addScriptTag({ path: axePath })
        found.push(...(await run(page, shell)).map((v) => `${role}@${width}: ${v}`))
        await ctx.close()
      }
    }

    const { ctx, page } = await open("organizer", 375, baseURL)
    await page.goto("/dashboard", { waitUntil: "networkidle" })
    await page.addScriptTag({ path: axePath })
    await clickUntil(page, trigger(page), () => expect(page.locator('[data-mobile="true"]')).toBeVisible({ timeout: 1000 }))
    found.push(...(await run(page, [['[data-mobile="true"]']])).map((v) => `sheet open: ${v}`))
    await page.keyboard.press("Escape")
    await page.setViewportSize({ width: 1440, height: 900 })
    const search = topbar(page).getByRole("button", { name: /^Search events/ })
    await clickUntil(page, search, () => expect(page.getByRole("dialog", { name: "Search" })).toBeVisible({ timeout: 1000 }))
    await page.getByRole("combobox", { name: "Search" }).fill("founders")
    await expect(page.getByRole("dialog").locator("[role='status']")).toHaveText(/result/)
    found.push(...(await run(page, [['[role="dialog"]']])).map((v) => `palette open: ${v}`))
    await ctx.close()

    expect(found).toEqual([])
  })
})

test("@sweep every role's every destination, at 375, 768 and 1440: one h1 in main, no sideways scroll", async ({
  baseURL,
}) => {
  test.setTimeout(900_000)
  const failures: string[] = []
  const measured: Record<string, number> = {}
  const expected: Record<string, number> = {}

  for (const role of ROLES) {
    const urls = [...new Set(visibleNavFor(ROLE_ACCOUNTS[role].role).map((i) => i.url))]
    expected[role] = urls.length * WIDTHS.length
    measured[role] = 0
    for (const width of WIDTHS) {
      const { ctx, page } = await open(role, width, baseURL)
      for (const url of urls) {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
        // A role's own nav never redirects it. If it does, that is the finding.
        if (new URL(page.url()).pathname !== url) {
          failures.push(`${role} ${width}px ${url}: redirected to ${new URL(page.url()).pathname}`)
          continue
        }
        measured[role]++
        const h1 = await page.locator("h1").count()
        const inMain = await page.locator("main h1").count()
        if (h1 !== 1 || inMain !== 1) failures.push(`${role} ${width}px ${url}: ${h1} h1, ${inMain} in main`)
        const over = await overflow(page)
        if (over > 1) failures.push(`${role} ${width}px ${url}: ${over}px sideways`)
      }

      if (width === WIDTHS[0]) {
        // The control, in-band: a second h1 must be caught by the same count.
        await page.evaluate(() => document.querySelector("main")!.prepend(Object.assign(document.createElement("h1"), { textContent: "x" })))
        expect(await page.locator("main h1").count(), "the h1 count must see a second h1").toBe(2)
      }
      await ctx.close()
    }
  }

  expect(failures).toEqual([])
  // Exactly every destination at every width, per role — not a floor.
  expect(measured).toEqual(expected)
})
