import { test, expect, type Page } from "@playwright/test"

/**
 * Picking a venue moves the pin — K1.1, the two maps that disagreed.
 *
 * Since SCRUM-343 the Location section renders **one** Leaflet map: the
 * check-in area editor, with the address search on it, whose centre is the
 * pin. It used to render two — `LocationPicker` (the pin) and `GeofenceEditor`
 * (the fence) — and the history below is why this test exists. Picking a venue writes `latitude`,
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

/**
 * The area's first handle is inside the map's box — on the map, not merely in
 * the DOM. Without Leaflet's stylesheet (SCRUM-344) the container did not clip
 * and the tiles stacked, so every marker still counted as "visible", about
 * 3,000 px below the map's top edge.
 *
 * The seeded Chinnaswamy fence is a polygon, so this handle is its first
 * corner rather than a centre pin; the stylesheet moves every marker alike.
 * Retried, because a venue's fence can zoom the map 18 → 16 and Leaflet
 * animates that.
 */
async function expectOnTheMap(page: Page) {
  const map = page.locator(".leaflet-container")
  await expect(map).toHaveCount(1)
  const handle = map.locator(".leaflet-marker-icon").first()
  await expect(handle).toBeAttached({ timeout: 15_000 })
  await expect(async () => {
    const mapBox = await map.boundingBox()
    const box = await handle.boundingBox()
    expect(mapBox).not.toBeNull()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(mapBox!.x)
    expect(box!.y).toBeGreaterThanOrEqual(mapBox!.y)
    expect(box!.x + box!.width).toBeLessThanOrEqual(mapBox!.x + mapBox!.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(mapBox!.y + mapBox!.height)
  }).toPass({ timeout: 10_000 })
}

test.describe("the venue picker and the pin agree", () => {
  test("a new event starts with no pin, then takes the venue's", async ({ page }) => {
    await page.goto("/dashboard/events/new")

    const picker = page.locator(".leaflet-container").first()
    await expect(picker).toBeVisible({ timeout: 30_000 })

    /*
     * The control, and it is what makes the assertions below mean something: a
     * new event has no coordinates. If it already had the venue's, "the pin is
     * at the venue after picking" would be true of the broken build too.
     *
     * Read from the form, not from markers. The map draws its placeholder
     * circle (draggable, unsaved until moved) as soon as Leaflet loads — since
     * SCRUM-345; before that, only once something else re-rendered the form,
     * and a "no marker yet" count here passed on that race.
     */
    const marker = picker.locator(".leaflet-marker-icon")
    await expect(page.locator("[data-lat]").first()).toHaveAttribute("data-lat", "")

    /*
     * Wait for the field to settle before typing.
     *
     * Filling as soon as the map appeared hit a strict-mode violation: two
     * inputs with this placeholder existed at that moment, and one a few
     * seconds later. `LocationSection` renders `WhereSearch` exactly once, so
     * the second is a hydration artefact rather than a duplicate in the tree —
     * transient, and gone by the time anything can interact with it. Asserting
     * the settled count says so, and fails if it ever becomes a real duplicate.
     */
    // One input for listed venues and places since SCRUM-353.
    const venueInput = page.getByRole("combobox", { name: "Venue or address" })
    await expect(venueInput.first()).toBeVisible({ timeout: 30_000 })
    await expect(venueInput).toHaveCount(1, { timeout: 30_000 })
    await venueInput.fill(AWAY_FROM_DEFAULT.name)

    // The LISTED venue ("M. Chinnaswamy Stadium", with the dot) — not the
    // geocoder's place of the same name, which the list also offers to add.
    const suggestion = page.getByRole("option", { name: /^M\. Chinnaswamy Stadium/ })
    await expect(suggestion.first()).toBeVisible({ timeout: 15_000 })
    await suggestion.first().click()

    // One map. The venue's outline arrives locked — no handles — with the
    // venue's own buffer chosen (SCRUM-353b); "Adjust for this event" opens it.
    await expect(page.locator(".leaflet-container")).toHaveCount(1)
    await expect(page.locator('[data-area-source="venue"]')).toBeVisible({ timeout: 15_000 })
    await expect(marker).toHaveCount(0)
    // The seeded venue's own buffer is 25 m (scripts/seed-qa.ts), not the default 20.
    await expect(page.getByRole("button", { name: "Venue's · 25 m" })).toHaveAttribute("aria-pressed", "true")
    await expect(page.locator('[data-area-source="venue"]')).toContainText("+25 m, the venue's buffer")
    await page.getByRole("button", { name: "Adjust for this event" }).click()
    await expect(marker.first()).toBeVisible({ timeout: 15_000 })

    await expectOnTheMap(page)

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

/*
 * The venue pages render the same editor and never had a LocationPicker to
 * borrow the stylesheet from, so they were broken on a direct load before the
 * event form was (SCRUM-344). Loaded by URL, not by clicking through: a
 * client-side navigation could carry a stylesheet over from the page before.
 */
test.describe("the venue page's check-in area map", () => {
  test("is on the map on a direct load", async ({ page }) => {
    await page.goto(`/dashboard/venues?q=${AWAY_FROM_DEFAULT.name}`)
    const link = page.getByRole("link", { name: new RegExp(AWAY_FROM_DEFAULT.name, "i") }).first()
    await expect(link).toBeVisible({ timeout: 30_000 })
    const href = await link.getAttribute("href")
    expect(href).toMatch(/^\/dashboard\/venues\/[^/?]+$/)

    await page.goto(href!)
    // Since SCRUM-354 the venue page's area takes drags only while "Adjust
    // area" is open, like the event form's; its buffer is the default every
    // event here starts with, on a named slider.
    await expect(page.getByRole("slider", { name: "Buffer, metres beyond the area" })).toBeVisible({ timeout: 30_000 })
    await page.getByRole("button", { name: "Adjust area" }).click()
    await expectOnTheMap(page)
  })
})
