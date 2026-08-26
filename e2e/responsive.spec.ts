import { test, expect, chromium, type Browser } from "@playwright/test"
import { readdirSync } from "node:fs"
import { join } from "node:path"

import { statePathFor } from "./global-setup"

/**
 * E17 — no dashboard page scrolls sideways, at any of the three widths.
 *
 * ## Why horizontal overflow and not "does it look right"
 *
 * Most responsive bugs are judgement calls that a test cannot settle. This one
 * is not: a page wider than its viewport is wrong at every width, on every
 * screen, for every reader, and the browser will say so in one number. It is
 * the objective half of a subjective problem, so it is the half worth pinning.
 *
 * It is also the failure this dashboard actually had. Driving the curation
 * screens at 375 found two `min-w-0 flex-1` items inside `flex-wrap` containers
 * that collapsed instead of wrapping — a nine-line title column, and a note
 * field whose placeholder truncated to "Reason — sent to the claimant, requi",
 * hiding the rule the control depends on. Neither is visible in the class
 * names; both are obvious the moment a real browser lays them out.
 *
 * ## The control is not optional
 *
 * A sweep that visits nothing reports a clean pass. So this asserts a floor on
 * pages actually measured, and then injects a deliberately over-wide node to
 * prove the measurement notices — the same reasoning as R16's recorded
 * mutations, done in-band because this is a browser spec rather than a
 * structural guard.
 */

/** 375: iPhone SE. 768: iPad portrait, the container-query breakpoint. 1280: laptop. */
const WIDTHS = [375, 768, 1280]

function dashboardRoutes(): string[] {
  const out: string[] = ["/dashboard"]
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("[")) continue
      const next = join(dir, entry.name)
      const nextUrl = `${url}/${entry.name}`
      if (readdirSync(next).includes("page.tsx")) out.push(nextUrl)
      walk(next, nextUrl)
    }
  }
  walk(join(__dirname, "..", "app", "dashboard"), "/dashboard")
  return out.sort()
}

let browser: Browser
test.beforeAll(async () => {
  browser = await chromium.launch()
})
test.afterAll(async () => {
  await browser.close()
})

test("no dashboard page scrolls sideways at 375, 768 or 1280", async ({ baseURL }) => {
  test.setTimeout(600_000)
  const overflowing: string[] = []
  let measured = 0

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({
      storageState: statePathFor("admin"),
      viewport: { width, height: 900 },
      baseURL,
    })
    const page = await ctx.newPage()

    for (const url of dashboardRoutes()) {
      /*
       * `networkidle` stays here: this measures layout, so the page genuinely
       * has to have settled, and unlike the role sweep this spec never timed
       * out. The navigation timeout is raised anyway — the failure mode that
       * hit the other spec was CPU starvation, and nothing about that is
       * specific to it.
       */
      await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
      // A page that redirected is not this page; measuring it would attribute
      // the destination's layout to the route that sent us there.
      if (new URL(page.url()).pathname !== url) continue
      measured++

      const { scrollW, clientW, widest } = await page.evaluate((w) => {
        const widest: string[] = []
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.right > w + 1) {
            widest.push(
              `${el.tagName}.${String((el as HTMLElement).className).slice(0, 50)} right=${Math.round(r.right)}`
            )
          }
        }
        return {
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          widest: widest.slice(0, 3),
        }
      }, width)

      if (scrollW > clientW + 1) {
        overflowing.push(`${width}px ${url} (${scrollW} > ${clientW}) — ${widest.join(" | ")}`)
      }
    }
    await ctx.close()
  }

  expect(
    { overflowing, hint: overflowing.length ? "A page is wider than its viewport." : "" },
    "a page wider than its viewport is wrong at every width"
  ).toEqual({ overflowing: [], hint: "" })

  // Floor: 27 pages an admin reaches, times three widths.
  expect(measured, "the sweep must actually visit pages").toBeGreaterThan(70)
})

test("the overflow measurement itself detects overflow", async ({ page }) => {
  // The control, run against a page rather than asserted about one: if this
  // stops failing, the sweep above proves nothing.
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto("/login")
  const before = await page.evaluate(() => document.documentElement.scrollWidth)
  await page.evaluate(() => {
    const d = document.createElement("div")
    d.style.cssText = "width:2000px;height:10px"
    document.body.appendChild(d)
  })
  const after = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }))
  expect(before, "the login page itself must not already overflow").toBeLessThanOrEqual(376)
  expect(after.scrollW, "an over-wide node must move scrollWidth").toBeGreaterThan(after.clientW + 1)
})
