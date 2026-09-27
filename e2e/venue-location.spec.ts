import { test, expect } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * The venue pages find the place the way the event form does (SCRUM-354), and
 * the organisation that added an unclaimed venue can correct it — the record
 * only (SCRUM-361).
 *
 * CI serves the recorded Nominatim answer for "M Chinnaswamy Stadium" (an area
 * with its own outline, e2e/fixtures/osm/search-chinnaswamy.json). The seeded
 * world lists "M. Chinnaswamy Stadium", so the duplicate check answers too.
 */
test.skip(!process.env.GEOCODE_UPSTREAM, "needs the OSM stub (GEOCODE_UPSTREAM) — never the real Nominatim")

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const made: string[] = []

test.afterAll(async () => {
  await db.venues.deleteMany({ where: { id: { in: made } } })
  await db.$disconnect()
})

test.describe("a venue owner adds a venue: the outline arrives with the place", () => {
  test.use({ storageState: "e2e/.auth/venue.json" })

  test("search → the OSM outline, the default buffer every event starts with → saved → drawn on a direct load", async ({ page }) => {
    const name = `e2e Stadium ${Date.now()}`
    await page.goto("/dashboard/venues/new")
    await page.getByLabel("Venue name").fill(name)
    await page.getByLabel("Search venue types").fill("stadium")
    await page.getByRole("button", { name: "Stadium", exact: true }).click()
    // The stepper names the stages too; the last match is the Next button.
    const next = (stage: string) => page.getByRole("button", { name: new RegExp(`^${stage}`) }).last()
    await next("Location").click()

    // Nothing picked yet: "Find the building" has no place to look at, and
    // must not search the map's default centre (React review).
    await page.getByRole("button", { name: "Adjust area" }).click()
    await expect(page.getByRole("button", { name: "Draw it yourself" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Find the building again" })).toHaveCount(0)
    await page.getByRole("button", { name: "Adjust area" }).click()

    await page.getByRole("combobox", { name: "Place or address" }).fill("M Chinnaswamy Stadium")
    // Places only: a listed venue here is a duplicate to claim, not a pick.
    await expect(page.getByText("Listed venues")).toHaveCount(0)
    const hit = page.getByRole("option", { name: /Chinnaswamy Stadium, Link Road/ })
    await expect(hit).toBeVisible({ timeout: 15_000 })
    await hit.click()

    const cite = page.locator('[data-area-source="osm-area"]')
    await expect(cite).toBeVisible({ timeout: 15_000 })
    await expect(cite).toContainText("+20 m, the default every event here starts with")
    await expect(page.locator(".leaflet-container .leaflet-marker-icon")).toHaveCount(0)
    await expect(page.getByRole("slider", { name: "Buffer, metres beyond the area" })).toHaveAttribute("aria-valuenow", "20")
    await expect(page.getByRole("spinbutton", { name: "Latitude" })).toHaveCount(0)
    await expect(page.locator("#venue-address")).toHaveValue(/Chinnaswamy Stadium/)

    // The seeded M. Chinnaswamy Stadium is right here: claim it, or say it is different.
    await expect(page.getByText(/already listed here/)).toBeVisible({ timeout: 15_000 })
    await page.getByLabel(/This is a different place/).check()
    await next("Capacity").click()
    await next("Review").click()
    await expect(page.getByText(/^Outline, \d+ corners, \+20 m for every event here$/)).toBeVisible()
    await page.getByRole("button", { name: "Create venue" }).click()
    await expect(page).toHaveURL(/\/dashboard\/venues\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    const id = new URL(page.url()).pathname.split("/").pop()!
    made.push(id)

    const row = await db.venues.findUniqueOrThrow({ where: { id }, select: { geofence: true, latitude: true, longitude: true } })
    expect(row.geofence).toMatchObject({ type: "polygon", buffer: 20 })
    expect((row.geofence as { ring: unknown[] }).ring.length).toBeGreaterThan(10)
    // The pin is the outline's centre, inside the stadium.
    expect(row.latitude).toBeGreaterThan(12.97)
    expect(row.latitude).toBeLessThan(12.99)

    // A direct load draws what was stored (the SCRUM-345 guard), and cites it.
    await page.goto(`/dashboard/venues/${id}`)
    await expect(page.locator('[data-area-source="saved"]:visible')).toContainText("The venue's outline", { timeout: 30_000 })
    await expect(page.locator(".leaflet-container path.leaflet-interactive").first()).toBeAttached({ timeout: 15_000 })
  })
})

test.describe("a building found late keeps the buffer changed meanwhile", () => {
  test.use({ storageState: "e2e/.auth/venue.json" })

  test("the slider moves while the lookup is out; the outline arrives with the slider's value (React review)", async ({ page }) => {
    // The stub finds no buildings, so this answer is the browser's, held back.
    await page.route("**/api/footprint**", async (route) => {
      await new Promise((r) => setTimeout(r, 2500))
      const d = 0.0001
      await route.fulfill({
        json: { ring: [[12.9794 - d, 77.6406 - d], [12.9794 - d, 77.6406 + d], [12.9794 + d, 77.6406 + d], [12.9794 + d, 77.6406 - d]] },
      })
    })
    await page.goto("/dashboard/venues/new")
    await page.getByLabel("Venue name").fill(`e2e Late ${Date.now()}`)
    await page.getByLabel("Search venue types").fill("pub")
    await page.getByRole("button", { name: "Pub or bar", exact: true }).click()
    await page.getByRole("button", { name: /^Location/ }).last().click()

    await page.getByRole("combobox", { name: "Place or address" }).fill("Toit Indiranagar")
    await page.getByRole("option", { name: /^Toit, 298/ }).click()
    await expect(page.locator('[data-area-source="circle"]')).toBeVisible({ timeout: 15_000 })
    const slider = page.getByRole("slider", { name: "Buffer, metres beyond the area" })
    await slider.focus()
    await page.keyboard.press("ArrowRight")
    await expect(slider).toHaveAttribute("aria-valuenow", "25")

    const cite = page.locator('[data-area-source="building"]')
    await expect(cite).toBeVisible({ timeout: 15_000 })
    await expect(cite).toContainText("+25 m")
  })
})

test.describe("the organisation that added an unclaimed venue corrects it — the record, nothing else (SCRUM-361)", () => {
  test.use({ storageState: "e2e/.auth/organizer.json" })

  async function orgOf(email: string) {
    const m = await db.organisation_members.findFirstOrThrow({ where: { user: { email } }, select: { org_id: true } })
    return m.org_id
  }

  test("its own: the record opens, no events or Retire, a rename is stored; another org's: turned away", async ({ page }) => {
    const mine = await db.venues.create({
      data: { name: `e2e Added ${Date.now()}`, latitude: 12.9719, longitude: 77.6412, venue_type: "pub_bar", created_by_org_id: await orgOf("organizer@blendn.app") },
      select: { id: true, name: true },
    })
    const theirs = await db.venues.create({
      data: { name: `e2e Theirs ${Date.now()}`, latitude: 12.9721, longitude: 77.6415, created_by_org_id: await orgOf("venue.owner@blendn.app") },
      select: { id: true },
    })
    made.push(mine.id, theirs.id)

    await page.goto(`/dashboard/venues/${mine.id}`)
    await expect(page.getByText("unclaimed — added by your organisation")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Events here", { exact: true })).toHaveCount(0)
    await expect(page.getByText("Ratings", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Retire" })).toHaveCount(0)

    await page.getByLabel("Name").fill(`${mine.name} (corrected)`)
    await page.getByRole("button", { name: "Save" }).click()
    await expect.poll(async () => (await db.venues.findUniqueOrThrow({ where: { id: mine.id }, select: { name: true } })).name, { timeout: 15_000 }).toBe(`${mine.name} (corrected)`)

    await page.goto(`/dashboard/venues/${theirs.id}`)
    await expect(page).not.toHaveURL(new RegExp(theirs.id))
  })
})
