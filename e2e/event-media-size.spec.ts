import { test, expect, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * The editor measures a picked file and the row keeps it (SCRUM-1066).
 *
 * Only a browser can decode the file, so only this lane sees the measuring:
 * a clip over 15 s refused before anything uploads, a "15 second" export that
 * measures 15.2 kept, a rotated photo sized as displayed, and the sizes
 * surviving a save that recreates every media row. Storage is stubbed; the
 * save and the rows are real. VP9 clips: the bundled Chromium has no H.264.
 */
test.use({ storageState: "e2e/.auth/admin.json" })

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const fixture = (name: string) => `e2e/fixtures/media/${name}`
let eventId: string | undefined

test.afterAll(async () => {
  if (eventId) await db.events.deleteMany({ where: { id: eventId } })
  await db.$disconnect()
})

async function rows() {
  return db.event_media.findMany({
    where: { event_id: eventId },
    orderBy: { order: "asc" },
    select: { type: true, width: true, height: true, duration_ms: true },
  })
}

async function openGallery(page: Page) {
  await page.goto(`/dashboard/events/${eventId}/edit`)
  await page.locator('button[aria-expanded="false"]', { hasText: "More" }).click()
  await expect(page.getByRole("button", { name: "Add Image" })).toBeVisible()
}

async function save(page: Page) {
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/events/${eventId}`) && r.request().method() === "PATCH")
  await page.getByRole("button", { name: "Save as draft" }).first().click()
  expect((await saved).status()).toBe(200)
}

test("a picked clip and photo keep their measured size; a clip over 15 s is refused before it uploads", async ({ page }) => {
  let presigned = 0
  await page.route("**/api/uploads/presigned-url", (route) => {
    presigned++
    const { filename } = route.request().postDataJSON()
    return route.fulfill({
      json: { success: true, data: { uploadUrl: new URL("/__e2e-put", page.url()).href, publicUrl: `https://media.example.com/${filename}` } },
    })
  })
  await page.route("**/__e2e-put", (route) => route.fulfill({ status: 200, body: "" }))
  const card = (n: number) =>
    page.locator("div.rounded-lg.border", { has: page.getByRole("button", { name: `Remove media item ${n}` }) }).last()
  const file = (n: number) => card(n).locator('input[type="file"]')
  const url = (n: number) => page.locator(`input[name="media_items.${n - 1}.url"]`)

  await page.goto("/dashboard/events/new")
  await page.locator(`input[name="title"]`).fill("e2e media size (SCRUM-1066)")
  await page.getByLabel("Description").fill("Saved by e2e/event-media-size.spec.ts.")
  await page.getByLabel("Starts").fill("2030-11-10T19:00")
  await page.getByLabel("Ends").fill("2030-11-10T22:00")
  await page.getByRole("button", { name: "Save draft" }).first().click()
  await expect(page).toHaveURL(/\/dashboard\/events\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  eventId = new URL(page.url()).pathname.split("/").pop()!

  await openGallery(page)
  await page.getByRole("button", { name: "Add Image" }).click()
  await card(1).getByRole("combobox").click()
  await page.getByRole("option", { name: "Video" }).click()

  // 20 s: refused beside the input, and nothing was asked of storage.
  await file(1).setInputFiles(fixture("clip-20s.mp4"))
  const refusal = card(1).getByRole("alert")
  await expect(refusal).toHaveText("This clip is 20.0 seconds. Clips play up to 15 seconds: trim it and upload again.")
  await expect(file(1)).toHaveAttribute("aria-invalid", "true")
  await expect(file(1)).toHaveAttribute("aria-describedby", (await refusal.getAttribute("id"))!)
  await expect(url(1)).toHaveValue("")
  expect(presigned).toBe(0)

  // It stays until the next pick; 15.2 s is a "15 second" export, and kept.
  await file(1).setInputFiles(fixture("clip-15s2.mp4"))
  await expect(url(1)).toHaveValue("https://media.example.com/clip-15s2.mp4")
  await expect(refusal).toHaveCount(0)
  await expect(page.locator('input[name="media_items.0.thumbnail_url"]')).toHaveValue(/clip-15s2-poster\.jpg$/)

  // Stored 400 × 300 with EXIF orientation 6: displayed 300 × 400.
  await page.getByRole("button", { name: "Add Image" }).click()
  await file(2).setInputFiles(fixture("photo-rotated.jpg"))
  await expect(url(2)).toHaveValue("https://media.example.com/photo-rotated.jpg")

  const measured = [
    { type: "video", width: 180, height: 320, duration_ms: 15_200 },
    { type: "image", width: 300, height: 400, duration_ms: null },
  ]
  await save(page)
  expect(await rows()).toEqual(measured)

  // An edit that touches something else recreates the rows: the sizes survive.
  await openGallery(page)
  await page.locator(`input[name="title"]`).fill("e2e media size, edited (SCRUM-1066)")
  await save(page)
  expect(await rows()).toEqual(measured)

  // A typed URL is another file, so its size is not the upload's.
  await openGallery(page)
  await url(1).fill("https://media.example.com/other.mp4")
  await save(page)
  expect(await rows()).toEqual([{ type: "video", width: null, height: null, duration_ms: null }, measured[1]])
})
