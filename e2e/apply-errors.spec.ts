import { test, expect } from "@playwright/test"

/**
 * /apply says what is wrong, to a screen reader as well as on screen (SCRUM-470).
 *
 * Driven on staging after #545: an empty submit moved focus to the first field
 * and the browser showed its bubble, but `[aria-invalid=true]` matched 0 and
 * `[role=alert]` with text matched 0. A server refusal (a bad GSTIN, the rate
 * limit) arrived only as a toast that came and went.
 *
 * In a real browser, because the errors come from the browser's own constraint
 * validation and its `invalid` events, which a server render cannot produce.
 */

// RFC 2544 benchmarking range, unique per run: the apply route allows 3 per hour per IP.
const RUN = Math.floor(Math.random() * 250) + 1

test("an empty submit marks each refused field, says why under it, and sums it up once", async ({ page }) => {
  await page.goto("/apply")
  await page.getByRole("button", { name: "Submit application" }).click()

  const invalid = page.locator("[aria-invalid=true]")
  await expect(invalid).toHaveCount(3)
  for (const control of await invalid.all()) {
    const ids = ((await control.getAttribute("aria-describedby")) ?? "").split(" ").filter(Boolean)
    const said = await Promise.all(ids.map((id) => page.locator(`[id="${id}"]`).textContent()))
    // The browser's own message ("Please fill out this field." in Chromium), tied to the field.
    expect(said.join(" ")).toMatch(/fill out|fill in|required/i)
  }
  await expect(page.locator("form [role=alert]")).toHaveText(
    "3 fields need attention: Name people will see, Full name, Work email."
  )

  // Fixing a field clears its error, and only its error.
  await page.getByLabel("Name people will see").fill("Basement Six")
  await expect(page.getByLabel("Name people will see")).not.toHaveAttribute("aria-invalid", "true")
  await expect(invalid).toHaveCount(2)
})

test("a refusal from the server is read out, not only toasted", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": `198.19.${RUN}.1` })
  await page.goto("/apply")
  await page.getByLabel("Name people will see").fill("Basement Six")
  await page.getByLabel("Full name").fill("Dev Kumar")
  await page.getByLabel("Work email").fill(`nights-${RUN}@toit.in`)
  await page.getByLabel("GSTIN").fill("29AABCU9603R1ZX")
  await page.getByRole("button", { name: "Submit application" }).click()

  await expect(page.locator("form [role=alert]")).toHaveText(/That GSTIN doesn't look right/)
})
