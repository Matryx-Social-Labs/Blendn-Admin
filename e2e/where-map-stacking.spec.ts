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
 * deliver a click to must belong to that surface, never to the map.
 */
test.use({ storageState: "e2e/.auth/admin.json" })
test.skip(!process.env.GEOCODE_UPSTREAM, "needs the OSM stub (GEOCODE_UPSTREAM) — never the real Nominatim")

/**
 * Classes of whatever sits on top of `selector` at any point of a 6 px grid
 * over it, 10 px in from its edges: hit-testing honours `border-radius`, so a
 * rounded corner lets the page beneath through. The zoom buttons sit 10–40 px
 * in from the map's left edge, so the inset still covers them.
 *
 * `elementFromPoint` answers null off-screen, so a surface below the fold would
 * pass by sampling nothing: the count of points actually hit-tested comes back
 * too.
 */
function foreignHits(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const surface = document.querySelector(sel)!
    const r = surface.getBoundingClientRect()
    const hits = new Set<string>()
    let sampled = 0
    for (let y = r.top + 10; y < r.bottom - 10; y += 6) {
      for (let x = r.left + 10; x < r.right - 10; x += 6) {
        const hit = document.elementFromPoint(x, y)
        if (!hit) continue
        sampled++
        if (!surface.contains(hit)) hits.add(String(hit.className) || hit.tagName)
      }
    }
    return { sampled, hits: [...hits] }
  }, selector)
}

async function openEventForm(page: Page) {
  await page.goto("/dashboard/events/new")
  await expect(page.locator(".leaflet-control-zoom-in")).toBeVisible({ timeout: 30_000 })
}

test("the venue suggestions sit above the map", async ({ page }) => {
  await openEventForm(page)
  await page.getByRole("combobox", { name: "Venue or address" }).fill("Toit Indiranagar")
  await expect(page.getByRole("option").first()).toBeVisible({ timeout: 15_000 })
  const list = page.getByRole("listbox")
  await list.scrollIntoViewIfNeeded()
  // The list drops over the map's top-left corner, where the zoom buttons are.
  const [listBox, zoomBox] = [await list.boundingBox(), await page.locator(".leaflet-control-zoom").boundingBox()]
  expect(zoomBox!.y).toBeLessThan(listBox!.y + listBox!.height)

  const over = await foreignHits(page, '[role="listbox"]')
  expect(over.sampled).toBeGreaterThan(100)
  expect(over.hits).toEqual([])
})

test("the sticky header sits above the map", async ({ page }) => {
  await openEventForm(page)
  // Scroll the zoom buttons up under the header.
  await page.evaluate(() => {
    const header = document.querySelector("header")!.getBoundingClientRect()
    const zoom = document.querySelector(".leaflet-control-zoom-in")!.getBoundingClientRect()
    window.scrollBy(0, zoom.top - (header.top + header.height / 2))
  })
  const [headerBox, zoomBox] = [await page.locator("header").boundingBox(), await page.locator(".leaflet-control-zoom-in").boundingBox()]
  expect(zoomBox!.y).toBeLessThan(headerBox!.y + headerBox!.height)

  const over = await foreignHits(page, "header")
  expect(over.sampled).toBeGreaterThan(100)
  expect(over.hits).toEqual([])
})
