import { test, expect, type Page, type Route } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * A clip added by link is checked in the editor (SCRUM-1106): the size, poster
 * and copies land on the row, a still is picked, a refused clip stops the save,
 * and a check that cannot be made does not. The worker's answer is stubbed at
 * the dashboard's route; the save and the rows are real.
 */
test.use({ storageState: "e2e/.auth/admin.json" })
test.skip(!process.env.MEDIA_WORKER_URL, "needs the clip check on (MEDIA_WORKER_URL, any address: the route is stubbed)")

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
let eventId: string | undefined

test.afterAll(async () => {
  if (eventId) await db.events.deleteMany({ where: { id: eventId } })
  await db.$disconnect()
})

const still = (i: number) => `https://media.example.com/still-${i}.jpg`
const renditions = [
  { url: "https://media.example.com/small.mp4", width: 540, height: 960, bytes: 1_500_000 },
  { url: "https://media.example.com/main.mp4", width: 1080, height: 1920, bytes: 4_000_000 },
]
const checked = {
  success: true,
  data: { width: 1080, height: 1920, duration_ms: 12_000, stills: [0, 1, 2, 3, 4, 5].map((i) => ({ url: still(i), at: i * 2 || 0.1 })), renditions },
}

async function row() {
  const [media] = await db.event_media.findMany({
    where: { event_id: eventId },
    select: { url: true, width: true, height: true, duration_ms: true, thumbnail_url: true, renditions: true },
  })
  return media
}

async function openGallery(page: Page) {
  await page.goto(`/dashboard/events/${eventId}/edit`)
  // By role, not a bare locator: the streamed page can hold a second, hidden copy for a moment.
  await page.getByRole("button", { name: /More gallery/, expanded: false }).click()
  await expect(page.getByRole("button", { name: "Add Image" })).toBeVisible()
}

const saveButton = (page: Page) => page.getByRole("button", { name: "Save as draft" }).first()

async function save(page: Page) {
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/events/${eventId}`) && r.request().method() === "PATCH")
  await saveButton(page).click()
  expect((await saved).status()).toBe(200)
}

test("a pasted clip is checked: facts, poster and copies saved; a refusal stops the save; an outage does not", async ({ page }) => {
  await page.route("https://media.example.com/**", (route) =>
    route.fulfill({ path: `e2e/fixtures/media/${route.request().url().endsWith(".mp4") ? "clip-15s2.mp4" : "photo-rotated.jpg"}` })
  )
  let answer: (route: Route) => Promise<void> = (route) => route.fulfill({ json: checked })
  const asked: string[] = []
  await page.route("**/api/media/clip", (route) => {
    asked.push(route.request().postDataJSON().url)
    return answer(route)
  })
  const url = page.locator('input[name="media_items.0.url"]')
  const poster = page.locator('input[name="media_items.0.thumbnail_url"]')

  await page.goto("/dashboard/events/new")
  await page.locator(`input[name="title"]:visible`).fill("e2e clip check (SCRUM-1106)")
  await page.getByLabel("Description").fill("Saved by e2e/clip-check.spec.ts.")
  await page.getByLabel("Starts").fill("2030-11-10T19:00")
  await page.getByLabel("Ends").fill("2030-11-10T22:00")
  await page.getByRole("button", { name: "Save draft" }).first().click()
  await expect(page).toHaveURL(/\/dashboard\/events\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  eventId = new URL(page.url()).pathname.split("/").pop()!

  // Pasted before the type is Video: nothing to check yet. The type starts it, and the save waits for it.
  let release = () => {}
  answer = async (route) => {
    await new Promise<void>((resolve) => (release = resolve))
    await route.fulfill({ json: checked })
  }
  await openGallery(page)
  await page.getByRole("button", { name: "Add Image" }).click()
  await url.fill("https://media.example.com/a.mp4")
  await url.blur()
  const card = page.locator("div.rounded-lg.border", { has: page.getByRole("button", { name: "Remove media item 1" }) }).last()
  await card.getByRole("combobox").click()
  expect(asked).toEqual([])
  await page.getByRole("option", { name: "Video" }).click()
  await expect(page.getByText("Checking the clip… this can take a minute. You can keep editing.")).toBeVisible()
  await expect(saveButton(page)).toBeDisabled()
  release()
  await expect(page.getByText("12.0 s · 1080 × 1920. Ready for the app, with a small copy for mobile data.")).toBeVisible()
  expect(asked).toEqual(["https://media.example.com/a.mp4"])

  // The opening frame is the poster; another still is one click, and the keyboard moves it on.
  await expect(poster).toHaveValue(still(0))
  const stills = page.getByRole("radiogroup", { name: "Or pick a still from the clip" })
  await expect(stills.getByRole("radio")).toHaveCount(6)
  await expect(stills.getByRole("radio", { name: "First frame" })).toBeChecked()
  await stills.getByRole("radio", { name: "0:04" }).click()
  await expect(poster).toHaveValue(still(2))
  // Radix selects the arrow's target while the key is down: a 0 ms press only moves the focus.
  await stills.getByRole("radio", { name: "0:04" }).press("ArrowRight", { delay: 120 })
  await expect(poster).toHaveValue(still(3))
  await save(page)
  expect(await row()).toEqual({ url: "https://media.example.com/a.mp4", width: 1080, height: 1920, duration_ms: 12_000, thumbnail_url: still(3), renditions })

  // Reopened: the line comes from the row, and nothing is asked by itself. Checked again, the chosen still stays.
  answer = (route) => route.fulfill({ json: checked })
  await openGallery(page)
  await expect(page.getByText("12.0 s · 1080 × 1920.")).toBeVisible()
  await url.focus()
  await url.blur()
  expect(asked).toHaveLength(1)
  await expect(stills).toHaveCount(0)
  await page.getByRole("button", { name: "Check again" }).click()
  await expect(stills.getByRole("radio", { name: "0:06" })).toBeChecked()
  await expect(poster).toHaveValue(still(3))

  // Another link: the old facts go at once, and a refusal is the URL's own message and stops the save.
  const refusal = "This clip is 20.2 seconds. Clips play up to 15 seconds: trim it and add it again."
  answer = (route) => route.fulfill({ status: 422, json: { success: false, error: refusal, errorCode: "CLIP_REFUSED" } })
  await url.fill("https://media.example.com/long.mp4")
  await expect(page.getByText("12.0 s · 1080 × 1920.")).toHaveCount(0)
  await url.blur()
  await expect(card.getByText(refusal)).toHaveCount(1)
  await expect(url).toHaveAttribute("aria-invalid", "true")
  let patched = 0
  page.on("request", (r) => void (r.method() === "PATCH" && patched++))
  await saveButton(page).click()
  await expect(card.getByText(refusal)).toBeVisible()
  expect(patched).toBe(0)
  expect((await row()).url).toBe("https://media.example.com/a.mp4")

  // An outage says nothing about the clip: it saves unchecked, with none of the old clip's facts.
  answer = (route) => route.fulfill({ status: 503, json: { success: false, error: "x" } })
  await url.fill("https://media.example.com/b.mp4")
  await url.blur()
  await expect(page.getByText("We couldn’t check this clip right now. You can save it, and check it again later.")).toBeVisible()
  await expect(card.getByText(refusal)).toHaveCount(0)
  await save(page)
  expect(await row()).toMatchObject({ url: "https://media.example.com/b.mp4", width: null, duration_ms: null, renditions: null })

  // Reopened unchecked: it says so, and waits to be asked.
  const before = asked.length
  await openGallery(page)
  await expect(page.getByText("This clip hasn’t been checked yet.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Check clip" })).toBeVisible()
  expect(asked).toHaveLength(before)
})
