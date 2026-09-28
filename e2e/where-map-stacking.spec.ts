import { test, expect, type Page } from "@playwright/test"

/**
 * The check-in area map stays under the page (SCRUM-420).
 *
 * Leaflet gives its panes and controls z-indexes up to 1000. Unless the map's
 * wrapper starts a stacking context, those compete with the whole page: on
 * staging the zoom buttons covered the venue suggestions (z 900) — a click on
 * the first option's left edge zoomed the map instead of picking the venue —
 * and scrolled over the sticky header (z 20).
 *
 * Checked by hit-testing a grid over each surface: whatever the browser would
 * deliver a click to must belong to that surface, never to the map. That is
 * where a click lands, which is the harm; it does not see paint from layers
 * with `pointer-events: none`, such as the tiles.
 */
test.use({ storageState: "e2e/.auth/admin.json" })
test.skip(!process.env.GEOCODE_UPSTREAM, "needs the OSM stub (GEOCODE_UPSTREAM) — never the real Nominatim")

/** Hit-testing starts this far in from a surface's edges (see foreignHits). */
const INSET = 10

/**
 * Classes of whatever sits on top of `selector` at any point of a 6 px grid
 * over it, INSET px in from its edges: hit-testing honours `border-radius`, so
 * a rounded corner lets the page beneath through. The zoom buttons sit 10–40 px
 * in from the map's left edge, so the inset still covers them.
 *
 * `elementFromPoint` answers null off-screen, so a surface below the fold would
 * pass by sampling nothing: the count of points actually hit-tested comes back
 * too.
 */
function foreignHits(page: Page, selector: string) {
  return page.evaluate(
    ([sel, inset]) => {
      const surface = document.querySelector(sel)!
      const r = surface.getBoundingClientRect()
      const hits = new Set<string>()
      let sampled = 0
      for (let y = r.top + inset; y < r.bottom - inset; y += 6) {
        for (let x = r.left + inset; x < r.right - inset; x += 6) {
          const hit = document.elementFromPoint(x, y)
          if (!hit) continue
          sampled++
          if (!surface.contains(hit)) hits.add(String(hit.className) || hit.tagName)
        }
      }
      return { sampled, hits: [...hits] }
    },
    [selector, INSET] as const
  )
}

/**
 * The zoom buttons lie inside the band foreignHits samples, on both axes, so
 * the test cannot pass because a layout change moved the map out from under
 * the surface.
 */
async function expectZoomUnder(page: Page, selector: string) {
  const [s, z] = [await page.locator(selector).first().boundingBox(), await page.locator(".leaflet-control-zoom").boundingBox()]
  expect(z!.x).toBeLessThan(s!.x + s!.width - INSET)
  expect(z!.x + z!.width).toBeGreaterThan(s!.x + INSET)
  expect(z!.y).toBeLessThan(s!.y + s!.height - INSET)
  expect(z!.y + z!.height).toBeGreaterThan(s!.y + INSET)
}

/** The event form with the suggestions open. The OSM stub's Toit is the row that always arrives. */
async function openSuggestions(page: Page) {
  await page.goto("/dashboard/events/new")
  await expect(page.locator(".leaflet-control-zoom-in")).toBeVisible({ timeout: 30_000 })
  await page.getByRole("combobox", { name: "Venue or address" }).fill("Toit Indiranagar")
  await expect(page.getByRole("option", { name: /^Toit, 298/ })).toBeVisible({ timeout: 15_000 })
}

test("the venue suggestions sit above the map", async ({ page }) => {
  await openSuggestions(page)
  await page.getByRole("listbox").scrollIntoViewIfNeeded()
  await expectZoomUnder(page, '[role="listbox"]')

  const over = await foreignHits(page, '[role="listbox"]')
  expect(over.sampled).toBeGreaterThan(100)
  expect(over.hits).toEqual([])
})

test("the sticky header sits above the map and the open suggestions", async ({ page }) => {
  // The list stays open while the input has focus, so it scrolls with the map.
  await openSuggestions(page)
  await page.evaluate(() => {
    const header = document.querySelector("header")!.getBoundingClientRect()
    const zoom = document.querySelector(".leaflet-control-zoom-in")!.getBoundingClientRect()
    window.scrollBy(0, zoom.top + zoom.height / 2 - (header.top + header.height / 2))
  })
  await expectZoomUnder(page, "header")

  const over = await foreignHits(page, "header")
  expect(over.sampled).toBeGreaterThan(100)
  expect(over.hits).toEqual([])
})
