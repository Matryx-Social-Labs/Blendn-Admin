import { readFileSync } from "node:fs"
import { test, expect, chromium, type Browser, type Page } from "@playwright/test"

import type { RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * One event, every tab, under one header (step 15).
 *
 * As the organiser: the header's "QR code" and "Edit event", each tab reached
 * by its link with the header and the tabs still there (Room chat is its own
 * route), and the QR & link tab handing over the event's address and nothing
 * else. As the venue owner on the same night: the room and the code, no
 * editor and no composer. axe finds nothing serious inside `main` on any tab.
 */

let browser: Browser
test.beforeAll(async () => {
  browser = await chromium.launch()
})
test.afterAll(async () => {
  await browser.close()
})

async function open(account: RoleKey, width: number, baseURL: string | undefined) {
  const ctx = await browser.newContext({ storageState: statePathFor(account), viewport: { width, height: 900 }, baseURL })
  return { ctx, page: await ctx.newPage() }
}

async function axeMain(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })
  return page.evaluate(async () => {
    type Axe = { run: (...a: unknown[]) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> }
    const res = await (window as unknown as { axe: Axe }).axe.run({ include: [["main"]] }, { resultTypes: ["violations"] })
    return res.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
  })
}

/** The seeded Nightshift night at The Humming Tree, found the way a person finds it. */
async function sunsetSessions(page: Page): Promise<string> {
  await page.goto("/dashboard/events", { waitUntil: "domcontentloaded" })
  const href = await page.getByRole("link", { name: /Sunset Sessions at The Humming Tree/ }).first().getAttribute("href")
  expect(href, "the seeded event is on the list").toBeTruthy()
  return href!
}

const main = (page: Page) => page.getByRole("main")
const tabs = (page: Page) => main(page).getByRole("navigation", { name: "Event sections" })

test("the organiser walks every tab under one header, and the QR & link tab hands over the event's address", async ({
  baseURL,
}) => {
  const found: string[] = []
  for (const width of [375, 1440]) {
    const { ctx, page } = await open("organizer", width, baseURL)
    const href = await sunsetSessions(page)
    const id = href.split("/").pop()!
    await page.goto(href, { waitUntil: "networkidle" })

    await expect(main(page).getByRole("heading", { level: 1, name: "Sunset Sessions at The Humming Tree" })).toBeVisible()
    await expect(main(page).getByRole("link", { name: "Edit event" })).toHaveAttribute("href", `/dashboard/events/${id}/edit`)
    // Membership, not an exact list: Live and Feedback come and go with the
    // seed's clock.
    for (const name of ["Overview", "Attendees", "Room chat", "Announcements & sponsors", "QR & link"]) {
      await expect(tabs(page).getByRole("link", { name, exact: true })).toBeVisible()
    }
    found.push(...(await axeMain(page)).map((v) => `overview@${width}: ${v}`))

    for (const [name, path] of [
      ["Attendees", `/dashboard/events/${id}?tab=attendees`],
      ["Room chat", `/dashboard/events/${id}/messaging`],
      ["Announcements & sponsors", `/dashboard/events/${id}?tab=announcements`],
    ] as const) {
      await tabs(page).getByRole("link", { name }).click()
      await expect(page).toHaveURL(new RegExp(`${path.replace(/[?]/g, "\\?")}$`))
      // The same header and tabs on every one, the current one marked.
      await expect(main(page).getByRole("heading", { level: 1 })).toHaveText("Sunset Sessions at The Humming Tree")
      await expect(tabs(page).getByRole("link", { name })).toHaveAttribute("aria-current", "page")
      await page.waitForLoadState("networkidle")
      found.push(...(await axeMain(page)).map((v) => `${name}@${width}: ${v}`))
    }

    // The header's "QR code" is the way in from anywhere.
    await main(page).getByRole("link", { name: "QR code" }).click()
    await expect(page).toHaveURL(new RegExp(`/dashboard/events/${id}\\?tab=share$`))
    await expect(tabs(page).getByRole("link", { name: "QR & link" })).toHaveAttribute("aria-current", "page")
    await expect(main(page).getByRole("textbox", { name: "Event link" })).toHaveValue(`https://www.blendn.app/event/${id}`)
    await expect(main(page).getByRole("img", { name: "QR code for Sunset Sessions at The Humming Tree" }).first()).toBeVisible()
    for (const action of ["Copy", "Download PNG", "Download SVG", "Full-screen slide", "Print for the door"]) {
      await expect(main(page).getByRole("button", { name: action })).toBeVisible()
    }
    const download = page.waitForEvent("download")
    await main(page).getByRole("button", { name: "Download PNG" }).click()
    const png = await download
    expect(png.suggestedFilename()).toBe("blendn-sunset-sessions-at-the-humming-tree-qr.png")
    // The file itself, decoded in the page: exactly 1024 px, and it scans to the event.
    const bytes = readFileSync((await png.path())!).toString("base64")
    await page.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") })
    const read = await page.evaluate(async (b64) => {
      const image = new Image()
      image.src = `data:image/png;base64,${b64}`
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")!
      context.drawImage(image, 0, 0)
      const data = context.getImageData(0, 0, canvas.width, canvas.height)
      type Decode = (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null
      const lib = (window as unknown as { jsQR: Decode | { default: Decode } }).jsQR
      const jsQR = typeof lib === "function" ? lib : lib.default
      return { width: image.naturalWidth, height: image.naturalHeight, data: jsQR(data.data, data.width, data.height)?.data ?? null }
    }, bytes)
    expect(read).toEqual({ width: 1024, height: 1024, data: `https://www.blendn.app/event/${id}` })

    // Printing prints the door slide and nothing else, and while the link
    // opens nothing (SCRUM-537) the slide carries no code and no address.
    await page.emulateMedia({ media: "print" })
    const slide = page.locator("[data-door-slide]")
    await expect(slide).toBeVisible()
    await expect(page.locator('[data-slot="sidebar-container"]')).toBeHidden()
    await expect(main(page)).toBeHidden()
    await expect(slide).toContainText("find this event by its name")
    await expect(slide.getByRole("img")).toHaveCount(0)
    await expect(slide).not.toContainText("www.blendn.app")
    await page.emulateMedia({ media: "screen" })
    await expect(slide).toBeHidden()
    found.push(...(await axeMain(page)).map((v) => `share@${width}: ${v}`))
    await ctx.close()
  }
  expect(found).toEqual([])
})

test("the venue owner, on a night at their venue: every tab as the venue, no code, no editor, no composer", async ({
  baseURL,
}) => {
  const found: string[] = []
  const { ctx, page } = await open("venue", 1440, baseURL)
  const href = await sunsetSessions(page)
  await page.goto(href, { waitUntil: "networkidle" })

  // The header: no QR code and no Edit event — the host's, not the building's.
  await expect(main(page).getByRole("heading", { level: 1, name: "Sunset Sessions at The Humming Tree" })).toBeVisible()
  await expect(main(page).getByRole("link", { name: "QR code" })).toHaveCount(0)
  await expect(main(page).getByRole("link", { name: "Edit event" })).toHaveCount(0)
  await expect(tabs(page).getByRole("link", { name: "QR & link" })).toHaveCount(0)
  await expect(tabs(page).getByRole("link", { name: "Announcements & sponsors" })).toHaveCount(0)

  // Overview: the glance in ranges or a dash, never an exact count of people.
  const glance = main(page).locator("section", { has: page.getByRole("heading", { name: "At a glance" }) })
  await expect(glance.getByText(/^(Under 5|5–9|10–19|20\+|—)$/).first()).toBeVisible()
  await expect(main(page).getByRole("heading", { name: "Your access to this event" })).toBeVisible()
  found.push(...(await axeMain(page)).map((v) => `venue overview: ${v}`))

  // Attendees: a count, no table of labels.
  await tabs(page).getByRole("link", { name: "Attendees" }).click()
  await expect(page).toHaveURL(/\?tab=attendees$/)
  await expect(main(page).locator("table")).toHaveCount(0)
  await expect(main(page).getByText(/attendee-[0-9a-f]{12}/)).toHaveCount(0)
  found.push(...(await axeMain(page)).map((v) => `venue attendees: ${v}`))

  // Room chat: the room and the queue, which is what the building operates.
  await tabs(page).getByRole("link", { name: "Room chat" }).click()
  await expect(page).toHaveURL(/\/messaging$/)
  await expect(main(page).getByRole("heading", { name: "Moderation" })).toBeVisible()
  await page.waitForLoadState("networkidle")
  found.push(...(await axeMain(page)).map((v) => `venue room: ${v}`))

  // And neither URL is a way round the tab list.
  for (const tab of ["share", "announcements"]) {
    await page.goto(`${href}?tab=${tab}`, { waitUntil: "networkidle" })
    await expect(page).toHaveURL(new RegExp(`${href}$`))
    await expect(main(page).getByText("Say something to the room")).toHaveCount(0)
    await expect(main(page).getByRole("textbox", { name: "Event link" })).toHaveCount(0)
  }
  await ctx.close()
  expect(found).toEqual([])
})
