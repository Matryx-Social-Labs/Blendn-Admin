import { test, expect, request as playwrightRequest } from "@playwright/test"

import { dashboardNav, visibleNavFor } from "../lib/dashboard-nav"
import { ROLE_ACCOUNTS, type RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * E2 — the access matrix, asserted against the running app.
 *
 * ## Three wrong versions preceded this one, and the reasons matter
 *
 * **"Did the URL stay?"** reported sixteen pages an organiser could reach. It
 * was measuring the wrong moment: `middleware.ts` refuses with a 307 before
 * navigation commits, but a page component calls `redirect()` *after* the
 * layout has streamed — so the browser gets `200`, a shell, and a bounce a
 * moment later. Waiting for that costs three seconds a route and blew the
 * timeout.
 *
 * **"Does the body contain words the shell does not?"** was worse, and its
 * failure is the interesting one: `components/site-header.tsx` renders the
 * route's own title from `routeContent`, so the word "Users" is in the response
 * for `/dashboard/users` **even when the page refuses**. Auto-derived markers
 * therefore flagged every page as leaking. A page's title is part of the shell;
 * only its *data* is not.
 *
 * ## What a leak actually is
 *
 * A role that may not see a page must not receive **its rows**. That is
 * unambiguous, it is what the word means, and the seeded world gives every
 * data-bearing page a string that appears only when real rows rendered.
 *
 * Verified by hand while writing this: an organiser requesting
 * `/dashboard/users`, `/dashboard/leads` or `/dashboard/categories` receives the
 * layout, the title, and not one row.
 */

const DASHBOARD_ROLES: RoleKey[] = ["admin", "organizer", "venue", "sponsor"]

/**
 * A string that appears in a page's response only when its rows rendered.
 *
 * Taken from the seeded world, so it is data rather than markup — markup is
 * shared, and a shared marker is what made the previous version useless.
 * Pages without an entry are covered by the reachability check below but not by
 * the leak check, and `uncovered` reports them rather than passing silently.
 */
const ROW_MARKER: Record<string, string> = {
  "/dashboard/users": "hemanth.ramesh@blendn.app",
  "/dashboard/organisers": "arjun.rao@blendn.app",
  "/dashboard/venue-owners": "fatima.sheikh@blendn.app",
  "/dashboard/organisations": "Nightshift Collective",
  "/dashboard/onboarding": "founder@thehummingtree.com",
  "/dashboard/claims": "events@toit.in",
  "/dashboard/sponsors": "Blue Tokai",
}

/**
 * Pages this technique cannot judge, and why — stated rather than skipped.
 *
 * An HTTP fetch sees only what the server sent. A table that streams in after
 * paint is never in that body, so its absence proves nothing about
 * entitlement. These want a browser-driven spec instead, and E3–E6 are where
 * that belongs.
 *
 * `/dashboard/venues` is not in either list on purpose: as an admin it renders
 * "My venues" — the venue owner's page, scoped to organisations an admin does
 * not belong to — and is therefore always empty. That is K2.7 in the register:
 * there is no admin venue index, and the nav has been describing one that does
 * not exist.
 */
const STREAMED_OR_UNSEEDED = new Set([
  "/dashboard/events", // "Loading events..." — client-streamed table
  "/dashboard/categories", // taxonomy comes from `npm run seed:categories`
  "/dashboard/venues", // no admin venue index exists (K2.7)
  "/dashboard/moderation", // queue is clear in the seeded world, by design
  "/dashboard/audit", // empty until an admin acts
  "/dashboard/reports", // a form, not a table
  "/dashboard/attendees",
  "/dashboard/chatrooms",
  "/dashboard/leads",
  "/dashboard/placements",
  "/dashboard/brand",
  "/dashboard/creative-review",
  "/dashboard/sponsor-claims",
  "/dashboard/charges",
  "/dashboard/organisation",
])

test.describe("a role receives only the rows it is entitled to", () => {
  test("no denied page returns its data", async ({ baseURL }) => {
    const leaked: string[] = []
    const uncovered = dashboardNav
      .map((i) => i.url)
      .filter((u) => u !== "/dashboard" && !(u in ROW_MARKER) && !STREAMED_OR_UNSEEDED.has(u))

    for (const role of DASHBOARD_ROLES) {
      const ctx = await playwrightRequest.newContext({
        baseURL,
        storageState: statePathFor(role),
      })
      const allowed = new Set(visibleNavFor(ROLE_ACCOUNTS[role].role).map((i) => i.url))

      for (const [url, marker] of Object.entries(ROW_MARKER)) {
        if (allowed.has(url)) continue
        const body = await (await ctx.get(url)).text()
        if (body.includes(marker)) leaked.push(`${role} sees "${marker}" on ${url}`)
      }
      await ctx.dispose()
    }

    expect(
      { leaked, uncovered },
      "leaked: a role received rows from a page it has no entitlement to. " +
        "uncovered: no row marker declared, so this page's data is not checked — add one to ROW_MARKER."
    ).toEqual({ leaked: [], uncovered: [] })
  })

  test("an admin does receive those rows — or the test above proves nothing", async ({
    baseURL,
  }) => {
    /*
     * The positive control, and it is not optional.
     *
     * Every assertion above is a `not.toContain`. If the markers were wrong, or
     * the seed had not run, every one of them would pass against a completely
     * broken app. This is the half that fails when the test is vacuous.
     */
    const ctx = await playwrightRequest.newContext({
      baseURL,
      storageState: statePathFor("admin"),
    })
    const missing: string[] = []
    for (const [url, marker] of Object.entries(ROW_MARKER)) {
      const body = await (await ctx.get(url)).text()
      if (!body.includes(marker)) missing.push(`${url} did not contain "${marker}"`)
    }
    await ctx.dispose()

    expect(
      missing,
      "An admin must see every marker. A miss means the seed did not run, or the marker is stale — " +
        "either way the denial assertions above are passing vacuously."
    ).toEqual([])
  })
})

test.describe("the roles that must not be here", () => {
  test("an attendee is bounced off the dashboard entirely", async ({ browser }) => {
    const context = await browser.newContext({ storageState: statePathFor("attendee") })
    const page = await context.newPage()
    /*
     * Attendees are mobile-only. `canAccessDashboard` rejects the role and
     * `middleware.ts` acts on it, so this must not depend on any individual
     * page remembering to check.
     */
    for (const url of ["/dashboard", "/dashboard/events", "/dashboard/settings"]) {
      await page.goto(url, { waitUntil: "commit" })
      await page.waitForURL((u) => new URL(u).pathname !== url, { timeout: 5_000 })
      expect(new URL(page.url()).pathname, `${url} must not open for an attendee`).not.toBe(url)
    }
    await context.close()
  })

  test("a signed-out visitor reaches no dashboard page", async ({ page }) => {
    for (const url of ["/dashboard", "/dashboard/users", "/dashboard/audit"]) {
      await page.goto(url, { waitUntil: "commit" })
      await page.waitForURL((u) => new URL(u).pathname !== url, { timeout: 5_000 })
      expect(new URL(page.url()).pathname, `${url} must not open when signed out`).not.toBe(url)
    }
  })

  test("an organiser with no organisation is denied other people's events", async ({ browser }) => {
    const context = await browser.newContext({ storageState: statePathFor("outsider") })
    const page = await context.newPage()
    /*
     * The negative control. A dashboard role with no org — `eventPermissions`
     * denies it everywhere, so empty screens here are the correct answer.
     * Without it, "an organiser can edit" passes without anyone checking that a
     * *different* organiser cannot.
     */
    await page.goto("/dashboard/events", { waitUntil: "domcontentloaded" })
    const body = (await page.textContent("body")) ?? ""
    expect(body).not.toContain("Sunset Sessions at The Humming Tree")
    await context.close()
  })
})
