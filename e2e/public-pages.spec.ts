import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * The public pages on the kit's two frames (step 18): sign in, the password
 * pages, an invite, a domain check, Apply and its confirmation, and both claim
 * pages. Each at a phone's, a tablet's and a desktop's width: exactly one
 * `h1`, nothing wider than the window, and nothing serious or critical under
 * axe across the whole page — there is no dashboard shell here, so the page is
 * all of it. Signed out, as the people they are for arrive.
 *
 * The numbers this prints (violations, overflow) are the ones TQ-X09 records.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
let browser: Browser

test.beforeAll(async () => {
  browser = await chromium.launch()
})
test.afterAll(async () => {
  await browser.close()
  await db.$disconnect()
})

async function axePage(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })
  return page.evaluate(async () => {
    type Axe = { run: (...a: unknown[]) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> }
    const res = await (window as unknown as { axe: Axe }).axe.run(document, { resultTypes: ["violations"] })
    return res.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
  })
}

/** How far the page is wider than the window, in px: 0 is the only right answer. */
const overflow = (page: Page) =>
  page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth))

/** A fake token: each page's "that link didn't work" state, which is the one a stranger can reach. */
const DEAD = "e2e-not-a-real-token"

test("each public page: one h1, no overflow, nothing serious under axe, at 375, 768 and 1440", async ({ baseURL }) => {
  test.setTimeout(300_000)

  // Ids from the seeded world, by the pages' own rules: a curated event nobody
  // has claimed, and a venue nobody owns.
  const curated = await db.events.findFirst({
    where: { curated_at: { not: null }, claimed_at: null, deleted_at: null, status: "published", visibility: "public", kind: "event" },
    select: { id: true, title: true },
    orderBy: { start_time: "desc" },
  })
  const unclaimed = await db.venues.findFirst({
    where: { owner_org_id: null, deleted_at: null, status: "active" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })
  expect(curated && unclaimed, "the seeded world has a curated event and an unclaimed venue").toBeTruthy()

  const PAGES: Array<{ path: string; h1: string | RegExp }> = [
    { path: "/login", h1: "Blend'n dashboard" },
    { path: "/forgot-password", h1: "Forgotten your password?" },
    { path: `/reset-password?token=${DEAD}`, h1: "This link no longer works" },
    { path: `/invite?token=${DEAD}`, h1: "Sign in to accept" },
    { path: `/verify-domain?token=${DEAD}`, h1: "That link didn't work" },
    { path: "/apply", h1: "Turn your crowd into a room where people actually meet." },
    { path: `/apply/verify?token=${DEAD}`, h1: "That link didn't work" },
    { path: `/claim/${curated!.id}`, h1: curated!.title },
    { path: `/claim/venue/${unclaimed!.id}`, h1: unclaimed!.name },
  ]

  const found: string[] = []
  const measured: string[] = []
  for (const width of [375, 768, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, baseURL })
    const page = await ctx.newPage()
    for (const p of PAGES) {
      await page.goto(p.path, { waitUntil: "networkidle" })
      // The pages that check a token settle after their request: wait for the heading, not a timer.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.h1)
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
      const wide = await overflow(page)
      const serious = await axePage(page)
      measured.push(`${p.path.split("?")[0]}@${width}: axe ${serious.length}, overflow ${wide}px`)
      if (wide > 0) found.push(`${p.path}@${width}: ${wide}px wider than the window`)
      found.push(...serious.map((v) => `${p.path}@${width}: ${v}`))
    }
    await ctx.close()
  }
  console.log(measured.join("\n"))
  expect(found).toEqual([])
})

test("Apply says what the plan is, not that pricing is undecided", async ({ baseURL }) => {
  const ctx = await browser.newContext({ baseURL })
  const page = await ctx.newPage()
  await page.goto("/apply")
  await expect(page.getByText("Analytics is an optional paid plan", { exact: false })).toBeVisible()
  // Superseded by the Free / Analytics model (the kit's NOTES-2).
  await expect(page.getByText("pricing isn't decided", { exact: false })).toHaveCount(0)
  // Person-reviewed (R6): no account is made by applying.
  await expect(page.getByText("Read by a person", { exact: false })).toBeVisible()
  await ctx.close()
})
