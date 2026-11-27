import { test, expect, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * The outline is traced on the street map, and the map says whose it is (SCRUM-1147).
 *
 * The editor's Satellite layer loaded Esri World Imagery with no key, which is
 * outside Esri's terms, and drawing switched to it. The layer and its toggle are
 * gone: no request reaches arcgisonline.com, and the OpenStreetMap credit links
 * to the copyright page, as OSM's tile policy asks.
 *
 * Driven as organizer@ rather than reasoned about: corners clicked by hand on
 * the street map, the draft saved, and the row read back. The screenshots at
 * 1280 and 768 are kept as a CI artefact (test-results/screens), where the
 * toggle's corner and the longer credit beside the legend are looked at.
 *
 * The credit also names Overture Maps Foundation, whose buildings may be the
 * outline drawn (SCRUM-1317), with no Leaflet prefix, so the line stays one
 * line clear of the legend down to a phone (390).
 */
test.use({ storageState: "e2e/.auth/organizer.json" })
test.skip(!process.env.GEOCODE_UPSTREAM, "needs the OSM stub (GEOCODE_UPSTREAM) — never the real Nominatim")

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const SCREENS = "test-results/screens"
const TITLE = "e2e street-map trace (SCRUM-1147)"

// By title, not id: a CI retry or a slow redirect after the save must not leave a row behind.
test.afterAll(async () => {
  await db.events.deleteMany({ where: { title: TITLE } })
  await db.$disconnect()
})

/** Corners as fractions of the map, clear of the zoom control (top left), the legend (bottom left) and the credit (bottom right). */
const CORNERS = [
  [0.55, 0.3],
  [0.8, 0.32],
  [0.78, 0.55],
  [0.5, 0.52],
] as const

/** The legend and the credit share the map's bottom edge; on a narrow map they touched (768, first CI run). */
async function expectLegendClearOfCredit(page: Page) {
  const legend = await page.getByText(/^GPS allowance/).locator("xpath=ancestor::div[1]").boundingBox()
  const credit = await page.locator(".leaflet-control-attribution").boundingBox()
  const map = await page.locator(".leaflet-container").boundingBox()
  console.log(`[credit] map ${Math.round(map!.width)} px wide, credit ${Math.round(credit!.width)}x${Math.round(credit!.height)}`)
  expect(legend!.y + legend!.height <= credit!.y || legend!.x + legend!.width <= credit!.x).toBe(true)
  // One line (12 px at 1.4): a wrapped credit grows upward into the legend's row.
  expect(credit!.height).toBeLessThan(12 * 1.4 * 2)
}

async function shoot(page: Page, name: string) {
  await page.locator(".leaflet-container").scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENS}/${name}.png` })
}

test("an outline traced by hand on the street map is saved; no Esri tile loads; the OSM credit links to its copyright page", async ({ page }) => {
  // Both, so an empty Esri list is a listener that saw tiles, not one that saw nothing.
  const esri: string[] = []
  let osmTiles = 0
  page.on("request", (r) => {
    if (r.url().includes("arcgisonline.com")) esri.push(r.url())
    if (r.url().includes("tile.openstreetmap.org/")) osmTiles++
  })
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.goto("/dashboard/events/new")
  const map = page.locator(".leaflet-container")
  await expect(map).toBeVisible({ timeout: 30_000 })
  await page.getByRole("combobox", { name: "Venue or address" }).fill("Toit Indiranagar")
  const hit = page.getByRole("option", { name: /^Toit, 298/ })
  await expect(hit).toBeVisible({ timeout: 15_000 })
  await hit.click()
  await expect(page.locator('[data-area-source="circle"]')).toBeVisible({ timeout: 15_000 })
  const pin = page.locator("[data-lat]").first()
  const pinAt = [Number(await pin.getAttribute("data-lat")), Number(await pin.getAttribute("data-lng"))]

  // One base map: no layer to choose, and the credit is a link. Soft, so a
  // regression reports every broken promise in one run, the Esri requests too.
  await expect.soft(page.getByRole("button", { name: "Satellite" })).toHaveCount(0)
  await expect.soft(map.locator("..").locator("[aria-pressed]")).toHaveCount(0)
  const credit = page.locator(".leaflet-control-attribution")
  await expect.soft(credit).toHaveText("© OpenStreetMap contributors, Overture Maps Foundation")
  await expect.soft(credit.locator('a[href="https://www.openstreetmap.org/copyright"]')).toHaveText("OpenStreetMap")
  const overture = credit.locator('a[href="https://docs.overturemaps.org/attribution/"]')
  await expect.soft(overture).toHaveText("Overture Maps Foundation")
  await expect.soft(overture).toHaveAttribute("target", "_blank")
  // Reachable by keyboard: focus lands on it and the ring is drawn (globals.css).
  await overture.focus()
  await expect.soft(overture).toBeFocused()
  await overture.blur()

  // Trace by hand: four corners, then close on the first.
  await page.getByRole("button", { name: "Adjust area" }).click()
  await page.getByRole("button", { name: "Draw it yourself" }).click()
  const box = (await map.boundingBox())!
  const clicked = CORNERS.map(([fx, fy]) => ({ x: Math.round(box.width * fx), y: Math.round(box.height * fy) }))
  const handles = map.locator(".leaflet-marker-icon")
  for (const [i, position] of clicked.entries()) {
    await map.click({ position })
    await expect(handles).toHaveCount(i + 1)
  }
  await expect(page.getByText("Click your first point to close the outline")).toBeVisible()
  await shoot(page, "trace-1280-drawing")
  await handles.first().click()
  await expect(page.getByText("Click your first point to close the outline")).toHaveCount(0)
  await page.getByRole("button", { name: "Adjust area" }).click()
  await expectLegendClearOfCredit(page)
  await shoot(page, "trace-1280-closed")

  await page.setViewportSize({ width: 768, height: 1024 })
  await expect.soft(credit.locator('a[href="https://www.openstreetmap.org/copyright"]')).toBeVisible()
  await expectLegendClearOfCredit(page)
  await shoot(page, "trace-768-closed")
  await credit.locator('a[href="https://docs.overturemaps.org/attribution/"]').focus()
  await shoot(page, "trace-768-credit-focus")

  // A phone: the narrowest map the staging proof is owed at.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.soft(credit.locator('a[href="https://docs.overturemaps.org/attribution/"]')).toBeVisible()
  await expectLegendClearOfCredit(page)
  await shoot(page, "trace-390-closed")
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.getByLabel("Title").fill(TITLE)
  await page.getByLabel("Description").fill("Saved by e2e/where-street-map-trace.spec.ts.")
  await page.getByLabel("Starts").fill("2030-11-12T19:00")
  await page.getByLabel("Ends").fill("2030-11-12T22:00")
  await page.getByRole("button", { name: "Save draft" }).first().click()
  await expect(page).toHaveURL(/\/dashboard\/events\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  const eventId = new URL(page.url()).pathname.split("/").pop()!

  // The read-back, as the task writes it.
  const [row] = await db.$queryRaw<{ geofence: { type: string; ring: [number, number][] } }[]>`
    SELECT geofence FROM events WHERE id = ${eventId}::uuid`
  console.log(`[read-back] SELECT geofence FROM events WHERE id = '${eventId}' -> ${JSON.stringify(row.geofence)}`)
  expect(row.geofence.type).toBe("polygon")
  expect(row.geofence.ring).toHaveLength(CORNERS.length)

  // The ring is the clicked corners: longitude follows x and latitude follows y
  // at one scale each (Web Mercator is affine at this size), within a pixel; on
  // the picked place, at a street zoom (z15-z20 is 4e-5 to 1.3e-6 degrees a pixel).
  const ring = row.geofence.ring
  const sx = (ring[1][1] - ring[0][1]) / (clicked[1].x - clicked[0].x)
  const sy = (ring[2][0] - ring[1][0]) / (clicked[2].y - clicked[1].y)
  expect(sx).toBeGreaterThan(1e-6)
  expect(sx).toBeLessThan(5e-5)
  expect(sy).toBeLessThan(0)
  const centre = [0, 1].map((k) => ring.reduce((sum, p) => sum + p[k], 0) / ring.length)
  expect(Math.abs(centre[0] - pinAt[0])).toBeLessThan(0.003)
  expect(Math.abs(centre[1] - pinAt[1])).toBeLessThan(0.003)
  ring.forEach(([lat, lng], i) => {
    expect(Math.abs(lng - (ring[0][1] + sx * (clicked[i].x - clicked[0].x)))).toBeLessThan(Math.abs(sx) * 1.5)
    expect(Math.abs(lat - (ring[0][0] + sy * (clicked[i].y - clicked[0].y)))).toBeLessThan(Math.abs(sy) * 1.5)
  })

  expect(osmTiles).toBeGreaterThan(0)
  expect(esri).toEqual([])
})
