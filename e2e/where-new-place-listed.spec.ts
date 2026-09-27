import { test, expect, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * A place picked from the map is listed as a venue when its event saves, and
 * the next event there picks it instead of drawing it (SCRUM-353c; the reuse
 * the owner asked for in SCRUM-352).
 *
 * Toit is a pub OSM holds only as a point (e2e/fixtures/osm/search-toit.json);
 * the stubbed Overpass finds no building, so the venue keeps the 30 m circle.
 * Every Toit this suite listed before is removed first — `where-buffer-adjust`
 * saves one too — so the first pick finds nothing listed.
 */
test.use({ storageState: "e2e/.auth/admin.json" })
test.skip(!process.env.GEOCODE_UPSTREAM, "needs the OSM stub (GEOCODE_UPSTREAM) — never the real Nominatim")

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const TOIT = { lat: 12.9794113, lng: 77.6406278 }

test.beforeAll(async () => {
  const listed = await db.venues.findMany({
    where: { name: "Toit", latitude: { gte: TOIT.lat - 0.001, lte: TOIT.lat + 0.001 } },
    select: { id: true },
  })
  const ids = listed.map((v) => v.id)
  await db.events.updateMany({ where: { venue_id: { in: ids } }, data: { venue_id: null, venue_link_status: null } })
  await db.venues.deleteMany({ where: { id: { in: ids } } })
})

test.afterAll(async () => {
  await db.$disconnect()
})

async function newEventAtToit(page: Page) {
  await page.goto("/dashboard/events/new")
  await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 30_000 })
  await page.getByRole("combobox", { name: "Venue or address" }).fill("Toit Indiranagar")
  const hit = page.getByRole("option", { name: /^Toit, 298/ })
  await expect(hit).toBeVisible({ timeout: 15_000 })
  await hit.click()
  await expect(page.locator('[data-area-source="circle"]')).toBeVisible({ timeout: 15_000 })
}

async function saveDraft(page: Page, title: string): Promise<string> {
  await page.getByLabel("Title").fill(title)
  await page.getByLabel("Description").fill("Saved by e2e/where-new-place-listed.spec.ts.")
  await page.getByLabel("Starts").fill("2030-11-10T19:00")
  await page.getByLabel("Ends").fill("2030-11-10T22:00")
  await page.getByRole("button", { name: "Save draft" }).click()
  await expect(page).toHaveURL(/\/dashboard\/events\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  return new URL(page.url()).pathname.split("/").pop()!
}

test("a picked place is listed when its event saves; the next event there uses it", async ({ page }) => {
  // First event: nothing listed there yet, so the place will be.
  await newEventAtToit(page)
  await expect(page.getByText("Saved as a venue when you save the event")).toBeVisible()
  const first = await saveDraft(page, "e2e new place listed (SCRUM-353c)")

  const linked = await db.events.findUniqueOrThrow({ where: { id: first }, select: { venue_id: true, venue_link_status: true } })
  expect(linked.venue_link_status).toBe("auto_linked")
  const venue = await db.venues.findUniqueOrThrow({
    where: { id: linked.venue_id! },
    select: { name: true, venue_type: true, owner_org_id: true, claimed_at: true, geofence: true, address: true },
  })
  expect(venue).toMatchObject({
    name: "Toit",
    venue_type: "pub_bar",
    owner_org_id: null,
    claimed_at: null,
    geofence: { type: "circle", radius: 30, buffer: 20 },
  })
  expect(venue.address).toMatch(/100 Feet Road/)

  // Second event, same place picked again: it is listed now — use it, and
  // the event links the same venue rather than adding a second.
  await newEventAtToit(page)
  const already = page.locator("[data-listed-nearby]")
  await expect(already).toContainText("Toit is already listed")
  await expect(page.getByText("Saved as a venue when you save the event")).toHaveCount(0)
  await already.getByRole("button", { name: "Use it" }).click()
  await expect(page.locator('[data-area-source="venue"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("button", { name: "Unlink the venue" })).toBeVisible()
  const second = await saveDraft(page, "e2e place reused (SCRUM-353c)")

  const reused = await db.events.findUniqueOrThrow({ where: { id: second }, select: { venue_id: true } })
  expect(reused.venue_id).toBe(linked.venue_id)
  expect(await db.venues.count({ where: { name: "Toit", deleted_at: null, latitude: { gte: TOIT.lat - 0.001, lte: TOIT.lat + 0.001 } } })).toBe(1)
})
