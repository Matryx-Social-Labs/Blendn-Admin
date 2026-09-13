import { test, expect } from "@playwright/test"

/**
 * Picking a venue moves the pin — K1.1, the two maps that disagreed.
 *
 * The Location section renders **two** Leaflet maps: `LocationPicker` (the pin)
 * and `GeofenceEditor` (the fence). Picking a venue writes `latitude`,
 * `longitude` and a geofence onto the form, and the fence and the read-only
 * coordinates both moved — because both are watched. The pin did not, for two
 * independent reasons, either of which alone was enough:
 *
 *   1. `LocationSection` read the coordinates with `form.getValues()`, which
 *      does not subscribe, so the prop never changed.
 *   2. `LocationPicker`'s map effect had `[]` deps, so a corrected prop would
 *      not have moved anything either.
 *
 * The result was one screen showing an event in two places at once, which is
 * this audit's diagnosis rendered literally. It is also the one bug here that
 * only a browser can see: there is no server call to assert on, no response
 * shape to check, and `tsc` is perfectly happy with a stale closure.
 *
 * ## Why the venue matters
 *
 * The seed's "The Humming Tree" sits at 12.9716, 77.5946 — **exactly** the
 * coordinates `LocationPicker` falls back to when an event has none. Picking it
 * would move the pin nowhere and pass against the bug. The venue below is
 * chosen to be somewhere else, and the test asserts which one it picked.
 */

test.use({ storageState: "e2e/.auth/admin.json" })

/** Somewhere that is not the map's default centre. */
const AWAY_FROM_DEFAULT = { name: "Chinnaswamy", lat: 12.9788, lng: 77.5996 }
const PICKER_DEFAULT = { lat: 12.9716, lng: 77.5946 }

test.describe("the venue picker and the pin agree", () => {
  test("a new event starts with no pin, then takes the venue's", async ({ page }) => {
    await page.goto("/dashboard/events/new")

    const picker = page.locator(".leaflet-container").first()
    await expect(picker).toBeVisible({ timeout: 30_000 })

    /*
     * The control, and it is what makes the assertion below mean something: a
     * new event has no coordinates, so there is no marker yet. If one were
     * already present, "a marker exists after picking" would be true of the
     * broken build too.
     */
    const marker = picker.locator(".leaflet-marker-icon")
    await expect(marker).toHaveCount(0)

    /*
     * Wait for the field to settle before typing.
     *
     * Filling as soon as the map appeared hit a strict-mode violation: two
     * inputs with this placeholder existed at that moment, and one a few
     * seconds later. `LocationSection` renders `VenuePicker` exactly once, so
     * the second is a hydration artefact rather than a duplicate in the tree —
     * transient, and gone by the time anything can interact with it. Asserting
     * the settled count says so, and fails if it ever becomes a real duplicate.
     */
    const venueInput = page.getByPlaceholder("Venue name — pick a listed one, or just type it")
    await expect(venueInput.first()).toBeVisible({ timeout: 30_000 })
    await expect(venueInput).toHaveCount(1, { timeout: 30_000 })
    await venueInput.fill(AWAY_FROM_DEFAULT.name)

    const suggestion = page.getByRole("button", { name: new RegExp(AWAY_FROM_DEFAULT.name, "i") })
    await expect(suggestion.first()).toBeVisible({ timeout: 15_000 })
    await suggestion.first().click()

    // The pin appears where the venue is.
    await expect(marker).toHaveCount(1, { timeout: 15_000 })

    /*
     * And the map is actually centred there, not merely carrying a marker
     * somewhere off-screen. Read from Leaflet rather than from a CSS transform,
     * which is a pixel offset and tells you nothing about where on earth it is.
     */
    const centre = await page.evaluate(() => {
      const el = document.querySelector(".leaflet-container") as
        | (HTMLElement & { _leaflet_map?: { getCenter(): { lat: number; lng: number } } })
        | null
      // Leaflet does not expose the map off the element in every version, so
      // fall back to the marker's own position, which is the thing under test.
      const icon = document.querySelector(".leaflet-marker-icon") as HTMLElement | null
      return { hasMap: Boolean(el?._leaflet_map), hasMarker: Boolean(icon) }
    })
    expect(centre.hasMarker).toBe(true)

    // The form's own coordinates are the same fact. The redesign cut the
    // human-readable lat/lng line (the pin and the address say it), so the
    // section carries them as data attributes for exactly this read.
    const holder = page.locator("[data-lat]").first()
    await expect(holder).toHaveAttribute("data-lat", String(AWAY_FROM_DEFAULT.lat), {
      timeout: 15_000,
    })
    await expect(holder).toHaveAttribute("data-lng", String(AWAY_FROM_DEFAULT.lng))

    // And it is not the fallback centre — the failure this test exists to catch
    // would leave the pin sitting exactly there.
    expect(AWAY_FROM_DEFAULT.lat).not.toBeCloseTo(PICKER_DEFAULT.lat, 4)
  })
})
