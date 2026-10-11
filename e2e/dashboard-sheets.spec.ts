import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { ROLE_ACCOUNTS } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * The dashboard's side sheets keep their bodies inside the header's inset
 * (SCRUM-593).
 *
 * `SheetHeader` and `SheetFooter` carry `p-4` and `SheetContent` carries
 * nothing, so a body written as `py-4` started at the sheet's left edge while
 * its title sat 16 px in: Users > Blendn+, Users > Edit and the credential
 * modal (both steps). Found driving SCRUM-583. The Blendn+ sheet also told a
 * grant twice, once above the control and once in it.
 *
 * Measured, not eyeballed: every control, label and line under the header
 * starts and ends no closer to the sheet's edge than the title does, at a
 * phone's width and a desktop's, with one h1, no sideways scroll and nothing
 * axe calls serious inside the sheet.
 */

/** What the credential modal's accounts are called, so they can be found and removed. */
const MINTED = "sheet-inset-"

let browser: Browser
let db: PrismaClient
test.beforeAll(async () => {
  browser = await chromium.launch()
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
})
test.afterAll(async () => {
  await browser.close()
  try {
    // The accounts the credential modal minted: later specs count organisers and users.
    await db.user.deleteMany({ where: { email: { startsWith: MINTED } } })
    await clearGrants()
  } finally {
    await db.$disconnect()
  }
})

/** The attendee this spec grants Blendn+ to holds no grant of ours before it or after it, pass or fail. */
async function clearGrants() {
  const person = await db.user.findUnique({ where: { email: ROLE_ACCOUNTS.attendee.email }, select: { id: true } })
  if (person) await db.entitlements.deleteMany({ where: { subject_kind: "user", subject_id: person.id, source: "grant" } })
}

const WIDTHS = [375, 1440] as const
const SHEET = '[data-slot="sheet-content"]'

interface Measured {
  /** Where the title starts, from the sheet's left edge. */
  inset: number
  minLeft: number
  minRight: number
  controls: number
  h1: number
  sideways: number
  /** Footer buttons, when the sheet has one: where each starts and ends from its edges. */
  footer: { left: number; right: number }[]
}

async function measure(page: Page): Promise<Measured> {
  return page.evaluate((sheetSelector) => {
    const sheet = document.querySelector(sheetSelector)!
    const box = sheet.getBoundingClientRect()
    const header = sheet.querySelector('[data-slot="sheet-header"]')!.getBoundingClientRect()
    const title = sheet.querySelector('[data-slot="sheet-title"]')!.getBoundingClientRect()
    // Under the header only (the close button sits in it), and never the
    // visually hidden native select Radix keeps for forms.
    const leaves = [...sheet.querySelectorAll("input, textarea, select, code, label, p, button, [role='combobox'], span")].filter((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.top >= header.bottom && !e.closest('[aria-hidden="true"]')
    })
    const rects = leaves.map((e) => e.getBoundingClientRect())
    const footer = [...sheet.querySelectorAll('[data-slot="sheet-footer"] button')].map((b) => {
      const r = b.getBoundingClientRect()
      return { left: Math.round(r.left - box.left), right: Math.round(box.right - r.right) }
    })
    return {
      inset: Math.round(title.left - box.left),
      minLeft: Math.round(Math.min(...rects.map((r) => r.left - box.left))),
      minRight: Math.round(Math.min(...rects.map((r) => box.right - r.right))),
      controls: leaves.length,
      h1: document.querySelectorAll("h1").length,
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      footer,
    }
  }, SHEET)
}

async function axeSheet(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })
  return page.evaluate(async (sheetSelector) => {
    type Axe = { run: (...a: unknown[]) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> }
    const res = await (window as unknown as { axe: Axe }).axe.run({ include: [[sheetSelector]] }, { resultTypes: ["violations"] })
    return res.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
  }, SHEET)
}

/** The body is inset as far as the title is, on both sides, and the footer's buttons line up with it. */
async function expectInset(page: Page, label: string, rows: string[]) {
  const m = await measure(page)
  const axe = await axeSheet(page)
  rows.push(`${label.padEnd(34)} title ${m.inset}px · body ${m.minLeft}px / ${m.minRight}px · ${m.controls} controls · h1 ${m.h1} · sideways ${m.sideways}px · axe ${axe.length} serious`)
  expect(m.controls, `${label}: nothing measured`).toBeGreaterThan(0)
  expect(m.minLeft, `${label}: starts nearer the left edge than the title`).toBeGreaterThanOrEqual(m.inset - 1)
  expect(m.minRight, `${label}: ends nearer the right edge than the title starts`).toBeGreaterThanOrEqual(m.inset - 1)
  for (const b of m.footer) {
    expect(b.left, `${label}: a footer button is not at the body's inset`).toBeGreaterThanOrEqual(m.inset - 1)
    expect(b.left, `${label}: a footer button is inset twice`).toBeLessThanOrEqual(m.inset + 1)
  }
  expect(m.h1, `${label}: h1`).toBe(1)
  expect(m.sideways, `${label}: sideways scroll`).toBe(0)
  expect(axe, `${label}: axe`).toEqual([])
}

async function rowMenu(page: Page, email: string, item: "Edit" | "Blendn+") {
  await page.goto("/dashboard/users", { waitUntil: "networkidle" })
  await page.getByRole("textbox", { name: "Search users by name or email" }).fill(email)
  const row = page.getByRole("row").filter({ hasText: email })
  await expect(row).toHaveCount(1)
  await row.getByRole("button", { name: "Open menu" }).click()
  await page.getByRole("menuitem", { name: item, exact: true }).click()
  await expect(page.locator(SHEET)).toBeVisible()
}

test("Users: the Edit sheet, the Blendn+ sheet (empty, then granted), and the credential modal, inset like their titles", async ({ baseURL }) => {
  test.setTimeout(240_000)
  await clearGrants()
  const rows: string[] = []
  const attendee = ROLE_ACCOUNTS.attendee.email

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ storageState: statePathFor("admin"), viewport: { width, height: 900 }, baseURL })
    const page = await ctx.newPage()

    await rowMenu(page, attendee, "Edit")
    await expectInset(page, `Users > Edit @${width}`, rows)

    await rowMenu(page, attendee, "Blendn+")
    await expect(page.locator(SHEET).getByText("No Blendn+ right now.")).toBeVisible()
    await expectInset(page, `Users > Blendn+ (none) @${width}`, rows)

    // Granted: the fact is told once, by the control that can end it.
    await page.getByRole("button", { name: "Grant Blendn+" }).click()
    await page.getByRole("textbox", { name: /Why this person gets Blendn\+/ }).fill("SCRUM-593 e2e: checking the sheet's inset")
    await page.locator(SHEET).getByRole("button", { name: "Grant", exact: true }).click()
    const sheet = page.locator(SHEET)
    await expect(sheet.getByText(/Blendn\+, granted until/)).toBeVisible()
    const told = (await sheet.innerText()).match(/until \d{1,2} \w{3} \d{4}/g) ?? []
    expect(told, "the grant is told once").toHaveLength(1)
    await expect(sheet.getByText(/Blendn\+ from a grant/)).toHaveCount(0)
    await expectInset(page, `Users > Blendn+ (granted) @${width}`, rows)

    // And put back: the seeded attendee holds no Blendn+ for the next spec.
    await sheet.getByRole("button", { name: "End grant" }).click()
    await page.getByRole("textbox", { name: "Why it ends" }).fill("SCRUM-593 e2e: putting it back")
    await sheet.getByRole("button", { name: "End grant" }).click()
    await expect(sheet.getByText("No Blendn+ right now.")).toBeVisible()

    // The credential modal: the form, then the one-time result.
    await page.goto("/dashboard/organisers", { waitUntil: "networkidle" })
    await page.getByRole("button", { name: "Generate credentials" }).click()
    await expect(page.locator(SHEET)).toBeVisible()
    await expectInset(page, `Credentials, form @${width}`, rows)
    await page.getByRole("textbox", { name: "Name" }).fill("Sheet Inset E2E")
    await page.getByRole("textbox", { name: "Email" }).fill(`${MINTED}${width}-${Date.now()}@itest.invalid`)
    await page.getByRole("button", { name: "Generate Credentials" }).click()
    await expect(page.locator(SHEET).getByText("Credentials Generated")).toBeVisible()
    await expectInset(page, `Credentials, result @${width}`, rows)

    await ctx.close()
  }
  console.log(`\n${rows.join("\n")}\n`)
})
