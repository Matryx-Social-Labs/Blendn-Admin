import { test, expect } from "@playwright/test"

/**
 * A stadium's address brings its outline (SCRUM-351, epic SCRUM-349).
 *
 * The owner asked for the outline to be found when the address is typed, for
 * free. Nominatim returns a place OSM holds as an area with its own outline
 * (`polygon_geojson`), and the form draws that as the check-in area — the pin
 * its centre, the typed address kept. CI points the geocoder at recorded
 * answers (e2e/fixtures/osm-stub.mjs, one real Nominatim response), so this
 * never calls OpenStreetMap.
 */
test.use({ storageState: "e2e/.auth/admin.json" })
test.skip(!process.env.GEOCODE_UPSTREAM, "needs the OSM stub (GEOCODE_UPSTREAM) — never the real Nominatim")

test("a stadium's search draws its own outline, with the pin at its centre", async ({ page }) => {
  await page.goto("/dashboard/events/new")
  const map = page.locator(".leaflet-container")
  await expect(map).toBeVisible({ timeout: 30_000 })

  await page.getByRole("combobox", { name: "Venue or address" }).fill("M Chinnaswamy Stadium")
  // The place to ADD (the geocoder's hit, "…, Link Road, …") — the seeded
  // world also lists "M. Chinnaswamy Stadium" as a venue in the same list.
  const hit = page.getByRole("option", { name: /Chinnaswamy Stadium, Link Road/ }).first()
  await expect(hit).toBeVisible({ timeout: 15_000 })
  await hit.click()

  // The outline is set, not offered for editing: no handles until "Adjust
  // area" (SCRUM-353b) — then every corner is one; a circle has two.
  await expect(page.locator('[data-area-source="osm-area"]')).toBeVisible({ timeout: 15_000 })
  await expect(map.locator(".leaflet-marker-icon")).toHaveCount(0)
  await page.getByRole("button", { name: "Adjust area" }).click()
  await expect.poll(() => map.locator(".leaflet-marker-icon").count(), { timeout: 15_000 }).toBeGreaterThan(10)

  // The pin is the outline's centre, not the geocoder's point.
  const pin = page.locator("[data-lat]").first()
  await expect(pin).not.toHaveAttribute("data-lat", "")
  const lat = Number(await pin.getAttribute("data-lat"))
  expect(lat).toBeGreaterThan(12.97)
  expect(lat).toBeLessThan(12.99)

  // And the address the search wrote stays under the map.
  await expect(page.locator('input[name="address"]')).toHaveValue(/Chinnaswamy Stadium/)
})
