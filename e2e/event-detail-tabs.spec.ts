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
    await expect(tabs(page).getByRole("link")).toHaveText([
      "Overview",
      "Attendees",
      "Room chat",
      "Announcements & sponsors",
      "QR & link",
    ])
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
    expect((await download).suggestedFilename()).toBe("blendn-sunset-sessions-at-the-humming-tree-qr.png")
    found.push(...(await axeMain(page)).map((v) => `share@${width}: ${v}`))
    await ctx.close()
  }
  expect(found).toEqual([])
})

test("the venue owner gets the room and the code on a night at their venue, and no editor or composer", async ({ baseURL }) => {
  const { ctx, page } = await open("venue", 1440, baseURL)
  const href = await sunsetSessions(page)
  await page.goto(href, { waitUntil: "networkidle" })
  await expect(main(page).getByRole("link", { name: "QR code" })).toBeVisible()
  await expect(main(page).getByRole("link", { name: "Edit event" })).toHaveCount(0)
  await expect(tabs(page).getByRole("link", { name: "Room chat" })).toBeVisible()
  await expect(tabs(page).getByRole("link", { name: "QR & link" })).toBeVisible()
  await expect(tabs(page).getByRole("link", { name: "Announcements & sponsors" })).toHaveCount(0)
  // And the URL is not a way round the tab list: the overview, and no composer.
  await page.goto(`${href}?tab=announcements`, { waitUntil: "networkidle" })
  await expect(tabs(page).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page")
  await expect(main(page).getByText("Say something to the room")).toHaveCount(0)
  await ctx.close()
})
