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
 *
 * And the focal point (SCRUM-1106): picked on a clip's poster with the pointer
 * and the keyboard, saved, kept through an edit, cleared by a new URL; a photo
 * that no card cuts gets no picker.
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
    select: { type: true, width: true, height: true, duration_ms: true, focal_x: true, focal_y: true },
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
  // The "uploaded" files, so the preview can draw them: a clip is the 15.2 s fixture, anything else the photo.
  await page.route("https://media.example.com/**", (route) =>
    route.fulfill({ path: fixture(new URL(route.request().url()).pathname.endsWith(".mp4") ? "clip-15s2.mp4" : "photo-rotated.jpg") })
  )
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
    { type: "video", width: 180, height: 320, duration_ms: 15_200, focal_x: null, focal_y: null },
    { type: "image", width: 300, height: 400, duration_ms: null, focal_x: null, focal_y: null },
  ]

  // A clip fills every card, so it always gets the picker. The pointer sets a point; Home clears it.
  const subject = card(1).getByRole("slider", { name: "Subject position" })
  await expect(subject).toHaveAttribute("aria-valuetext", "Not set: the center, a little high")
  await subject.click({ position: { x: 10, y: 10 } })
  await expect(subject).toHaveAttribute("aria-valuetext", /^x \d+%, y \d+%$/)
  await subject.press("Home")
  await expect(subject).toHaveAttribute("aria-valuetext", "Not set: the center, a little high")
  // From the default (50%, 40%): two steps right, one fine step down.
  await subject.press("ArrowRight")
  await subject.press("ArrowRight")
  await subject.press("Shift+ArrowDown")
  await expect(subject).toHaveAttribute("aria-valuetext", "x 60%, y 41%")
  // A 3:4 photo is shown whole in every card: nothing to pick.
  await expect(card(2).getByText("Nothing is cut. Every card shows this picture whole.")).toBeVisible()
  await expect(card(2).getByRole("slider")).toHaveCount(0)

  const picked = [{ ...measured[0], focal_x: 0.6, focal_y: 0.41 }, measured[1]]
  await save(page)
  expect(await rows()).toEqual(picked)

  // An edit that touches something else recreates the rows: the sizes survive.
  await openGallery(page)
  await page.locator(`input[name="title"]`).fill("e2e media size, edited (SCRUM-1066)")
  await save(page)
  expect(await rows()).toEqual(picked)

  // A typed URL is another file, so its size is not the upload's.
  await openGallery(page)
  await url(1).fill("https://media.example.com/other.mp4")
  await save(page)
  expect(await rows()).toEqual([
    { type: "video", width: null, height: null, duration_ms: null, focal_x: null, focal_y: null },
    measured[1],
  ])
})
