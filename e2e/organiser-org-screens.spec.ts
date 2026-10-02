import { test, expect, chromium, type Browser, type Page } from "@playwright/test"

import type { RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The rest of the organiser's screens on the kit (step 15, part 3): the event
 * form's panels and its "Before it can go out" rail, Attendees, Chatrooms,
 * Team, Reports and Audit — each with one h1, each clean under axe inside
 * `main` at a phone's width and a desktop's.
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

const main = (page: Page) => page.getByRole("main")

const SCREENS: Array<{ path: string; h1: string; check: (page: Page) => Promise<void> }> = [
  {
    path: "/dashboard/events/new",
    h1: "New event",
    check: async (page) => {
      for (const name of ["Basics", "When", "Where", "Who can come"]) {
        await expect(main(page).getByRole("heading", { name })).toBeVisible()
      }
    },
  },
  {
    path: "/dashboard/attendees",
    h1: "Attendees",
    check: async (page) => {
      for (const label of ["Unique attendees", "Came back", "No-show rate"]) {
        await expect(main(page).getByText(label, { exact: true })).toBeVisible()
      }
    },
  },
  {
    path: "/dashboard/chatrooms",
    h1: "Chatrooms",
    check: async (page) => {
      // Either a card per open room, each with its way in, or the empty state.
      const rooms = main(page).getByRole("link", { name: /^Open room/ })
      const empty = main(page).getByText("No rooms open")
      await expect(rooms.first().or(empty)).toBeVisible()
    },
  },
  {
    path: "/dashboard/organisation",
    h1: "Team",
    check: async (page) => {
      await expect(main(page).getByRole("heading", { name: "Members" })).toBeVisible()
    },
  },
  {
    path: "/dashboard/reports",
    h1: "Reports",
    check: async (page) => {
      // A CSV button per report, named by the report it downloads.
      await expect(main(page).getByRole("button", { name: /^Download Events CSV$/ })).toBeVisible()
    },
  },
  { path: "/dashboard/audit", h1: "Audit log", check: async () => {} },
]

test("each screen: one h1, the kit's pieces, and nothing serious under axe, at 375 and 1440", async ({ baseURL }) => {
  test.setTimeout(240_000)
  const found: string[] = []
  for (const width of [375, 1440]) {
    const { ctx, page } = await open("organizer", width, baseURL)
    for (const screen of SCREENS) {
      await page.goto(screen.path, { waitUntil: "networkidle" })
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(screen.h1)
      await screen.check(page)
      found.push(...(await axeMain(page)).map((v) => `${screen.path}@${width}: ${v}`))
    }
    await ctx.close()
  }
  expect(found).toEqual([])
})

test("a report downloads from its own row", async ({ baseURL }) => {
  const { ctx, page } = await open("organizer", 1440, baseURL)
  await page.goto("/dashboard/reports", { waitUntil: "networkidle" })
  const download = page.waitForEvent("download")
  await main(page).getByRole("button", { name: /^Download Events CSV$/ }).click()
  expect((await download).suggestedFilename()).toMatch(/\.csv$/)
  await ctx.close()
})
