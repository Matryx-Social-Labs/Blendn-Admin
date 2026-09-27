import { test, expect } from "@playwright/test"

/**
 * The area arrives set; the organiser chooses whose buffer, and adjusts the
 * shape only if it is wrong (SCRUM-353b, epic SCRUM-349).
 *
 * A pub OSM holds only as a point, on a NEW event. Before this, a new event
 * had no area for the pin to move, so picking a place without an outline saved
 * no area at all and check-in fell back to the bare radius. Now it gets a
 * circle on the pin — and says there was no outline. CI serves the recorded
 * answer (e2e/fixtures/osm/search-toit.json); Overpass is stubbed to "no
 * building".
 */
test.use({ storageState: "e2e/.auth/admin.json" })
test.skip(!process.env.GEOCODE_UPSTREAM, "needs the OSM stub (GEOCODE_UPSTREAM) — never the real Nominatim")

test("a pub with no outline gets a circle at the default buffer; Custom moves the ring live; Adjust opens the handles", async ({ page }) => {
  await page.goto("/dashboard/events/new")
  const map = page.locator(".leaflet-container")
  await expect(map).toBeVisible({ timeout: 30_000 })
  const handles = map.locator(".leaflet-marker-icon")
  // The legend sits over the map, beside Leaflet's container rather than in it.
  const legend = (line: string) => page.getByText(line, { exact: true })

  await page.getByRole("combobox", { name: "Venue or address" }).fill("Toit Indiranagar")
  const hit = page.getByRole("option", { name: /^Toit, 298/ })
  await expect(hit).toBeVisible({ timeout: 15_000 })
  await hit.click()

  // A circle, at the default buffer, cited as the fallback it is — and set:
  // no handles until the organiser asks to adjust it.
  const cite = page.locator('[data-area-source="circle"]')
  await expect(cite).toBeVisible({ timeout: 15_000 })
  await expect(cite).toContainText("+20 m, the default buffer")
  await expect(page.locator("[data-lat]").first()).not.toHaveAttribute("data-lat", "")
  await expect(legend("Circle — 30 m")).toBeVisible()
  await expect(legend("Buffer — 20 m, the default")).toBeVisible()
  await expect(handles).toHaveCount(0)
  const base = page.getByRole("button", { name: "Default · 20 m" })
  await expect(base).toHaveAttribute("aria-pressed", "true")

  // Custom: the slider, live — one step is 5 m, on the ring and in the citation.
  await page.getByRole("button", { name: "Custom" }).click()
  const slider = page.getByRole("slider", { name: "Buffer, metres beyond the area" })
  await slider.focus()
  await page.keyboard.press("ArrowRight")
  await expect(slider).toHaveAttribute("aria-valuenow", "25")
  await expect(cite).toContainText("+25 m, custom for this event")
  await expect(legend("Buffer — 25 m, custom")).toBeVisible()

  // Back to the default: the slider goes, the buffer is 20 again.
  await base.click()
  await expect(slider).toHaveCount(0)
  await expect(cite).toContainText("+20 m, the default buffer")

  // Adjust: the circle's two handles; no "circle instead" for a circle.
  await page.getByRole("button", { name: "Adjust area" }).click()
  await expect(handles).toHaveCount(2)
  await expect(page.getByRole("button", { name: "Draw it yourself" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Find the building again" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Use a circle instead" })).toHaveCount(0)

  // Closing it locks the shape again.
  await page.getByRole("button", { name: "Adjust area" }).click()
  await expect(handles).toHaveCount(0)
})
