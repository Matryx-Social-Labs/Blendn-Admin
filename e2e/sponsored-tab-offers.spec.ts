import { test, expect, type Page } from "@playwright/test"

import { statePathFor } from "./global-setup"

/**
 * The Sponsored tab offers only what will be accepted (SCRUM-308, SCRUM-475).
 *
 * organizer@'s organisation (Nightshift Collective) may not sponsor, so every
 * sponsored-message write answers "Forbidden". The tab used to offer the
 * composer anyway; now it says who places these. admin@ still writes them.
 */
async function sponsoredTab(page: Page) {
  await page.goto("/dashboard/events", { waitUntil: "domcontentloaded" })
  const href = await page.getByRole("link", { name: /Sunset Sessions at The Humming Tree/ }).first().getAttribute("href")
  expect(href, "the seeded event is on the list").toBeTruthy()
  // The composer is the event's Announcements & sponsors tab since step 15.
  await page.goto(`${href}?tab=announcements`, { waitUntil: "domcontentloaded" })
  await page.getByRole("tab", { name: "Sponsored" }).click()
  return page.getByRole("tabpanel", { name: "Sponsored" })
}

test("an organiser whose organisation may not sponsor is not offered the composer, and is told who places these", async ({ browser }) => {
  const context = await browser.newContext({ storageState: statePathFor("organizer") })
  const panel = await sponsoredTab(await context.newPage())

  await expect(panel.getByText("Placed by the brand's organisation or by Blend'n.", { exact: false })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Add" })).toHaveCount(0)
  await context.close()
})

test("an admin is still offered the composer", async ({ browser }) => {
  const context = await browser.newContext({ storageState: statePathFor("admin") })
  const panel = await sponsoredTab(await context.newPage())

  await expect(panel.getByRole("button", { name: "Add" })).toBeVisible()
  await expect(panel.getByText("Placed by the brand's organisation", { exact: false })).toHaveCount(0)
  await context.close()
})
