import { test, expect, type Page } from "@playwright/test"

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

  // Drawing by hand, one click in, then closing Adjust: one corner is not a
  // place. The pin stays where it was, and the circle comes back, cited.
  const pin = page.locator("[data-lat]").first()
  const lat = await pin.getAttribute("data-lat")
  await page.getByRole("button", { name: "Draw it yourself" }).click()
  await expect(cite).toHaveCount(0)
  const box = (await map.boundingBox())!
  // Away from the zoom control, the layer toggle and the legend.
  await map.click({ position: { x: box.width * 0.75, y: box.height * 0.4 } })
  await expect(handles).toHaveCount(1)
  await expect(pin).toHaveAttribute("data-lat", lat!)

  // Closing it locks the shape again.
  await page.getByRole("button", { name: "Adjust area" }).click()
  await expect(cite).toBeVisible()
  await expect(legend("Circle — 30 m")).toBeVisible()
  await expect(handles).toHaveCount(0)
})

/** Search, pick the option, and wait for the area it brings. */
async function pickPlace(page: Page, query: string, option: RegExp) {
  await page.getByRole("combobox", { name: "Venue or address" }).fill(query)
  const hit = page.getByRole("option", { name: option }).first()
  await expect(hit).toBeVisible({ timeout: 15_000 })
  await hit.click()
}

test("a place picked after a venue starts at the default buffer, not the venue's", async ({ page }) => {
  await page.goto("/dashboard/events/new")
  await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 30_000 })

  // The listed venue brings its 25 m (the seed's).
  await pickPlace(page, "Chinnaswamy", /^M\. Chinnaswamy Stadium/)
  await expect(page.locator('[data-area-source="venue"]')).toContainText("+25 m, the venue's buffer")

  // Changed their mind: unlink, and pick a pub instead.
  await page.getByRole("button", { name: "Unlink the venue" }).click()
  await pickPlace(page, "Toit Indiranagar", /^Toit, 298/)
  const cite = page.locator('[data-area-source="circle"]')
  await expect(cite).toBeVisible({ timeout: 15_000 })
  await expect(cite).toContainText("+20 m, the default buffer")
  await expect(page.getByRole("button", { name: "Default · 20 m" })).toHaveAttribute("aria-pressed", "true")
  // Nothing the organiser drew was lost, so nothing says an outline was cleared.
  await expect(page.getByText(/Outline cleared/)).toHaveCount(0)
})

test("a custom buffer is saved, and the edit page reads it back as Custom", async ({ page }) => {
  await page.goto("/dashboard/events/new")
  await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 30_000 })
  await pickPlace(page, "Toit Indiranagar", /^Toit, 298/)
  await expect(page.locator('[data-area-source="circle"]')).toBeVisible({ timeout: 15_000 })

  await page.getByRole("button", { name: "Custom" }).click()
  const slider = page.getByRole("slider", { name: "Buffer, metres beyond the area" })
  await slider.focus()
  await page.keyboard.press("ArrowRight")
  await expect(slider).toHaveAttribute("aria-valuenow", "25")

  // An empty form refuses in its own words, not Zod's "expected string, received undefined".
  await page.getByRole("button", { name: "Save draft" }).click()
  await expect(page.getByText("Description must be at least 10 characters.")).toBeVisible()
  await expect(page.getByText(/received undefined/)).toHaveCount(0)

  await page.getByLabel("Title").fill("e2e custom buffer (SCRUM-353b)")
  await page.getByLabel("Description").fill("Saved by e2e/where-buffer-adjust.spec.ts.")
  await page.getByLabel("Starts").fill("2030-10-10T19:00")
  await page.getByLabel("Ends").fill("2030-10-10T22:00")
  await page.getByRole("button", { name: "Save draft" }).click()
  await expect(page).toHaveURL(/\/dashboard\/events\/[0-9a-f-]{36}$/, { timeout: 30_000 })

  // The form loads what the row holds: 25 m, which is not the default — Custom.
  // `networkidle`: the edit route streams behind a loading boundary; let the
  // streamed copy settle and hydrate before reading the form's state.
  await page.goto(`${new URL(page.url()).pathname}/edit`, { waitUntil: "networkidle" })
  // `:visible`: a first dev-mode compile of the edit route can leave a hidden
  // copy of the section behind (never on a production server).
  const saved = page.locator('[data-area-source="saved"]:visible')
  await expect(saved).toBeVisible({ timeout: 30_000 })
  await expect(saved).toContainText("+25 m, custom for this event")
  await expect(page.getByRole("button", { name: "Custom" })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("slider", { name: "Buffer, metres beyond the area" })).toHaveAttribute("aria-valuenow", "25")
})
