import { test, expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { dashboardNav, visibleNavFor } from "../lib/dashboard-nav"
import { MATRIX_MARKERS } from "../scripts/seed-matrix-markers"
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
 * failure is the interesting one: the layout's `PageHeader` renders the
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
 * ## The refused response itself, not wherever it bounces to (step 18)
 *
 * Fetched with `maxRedirects: 0`. Followed, a refusal from `middleware.ts` (a
 * 307) lands on the role's own overview, and a sponsor's overview previews its
 * own sponsored copy — so a check that followed the bounce would report the
 * creative queue as leaking to the one role entitled to that sentence, and,
 * worse, would be judging the overview rather than the page refused. A refusal
 * is either a 3xx or a `200` carrying the shell and a `NEXT_REDIRECT` (the page
 * called `redirect()` after the layout streamed). Either way: no rows.
 */

/** The four dashboard roles that are not an admin. `outsider` is an organiser with no organisation. */
const HOSTS = ["organizer", "venue", "sponsor", "outsider"] as const satisfies readonly RoleKey[]
const DASHBOARD_ROLES = ["admin", ...HOSTS] as const

/**
 * A string that appears in a page's response only when its rows rendered.
 *
 * Taken from the seeded world, so it is data rather than markup — markup is
 * shared, and a shared marker is what made the previous version useless.
 *
 * Several per page, and they include the OTHER role accounts' own
 * organisations and addresses — the rows a leak would most plausibly carry.
 *
 * **Except, per role, its own organisation.** Since step 14 the shell names
 * who you act for on every page — the identity card and the first breadcrumb.
 * "Nightshift Collective" is in every page organizer@ opens; it is not a leak
 * there. (Measured: the account menu's name and email are not in the response
 * — the menu's content renders only when opened — so addresses get no
 * exception.) So each role is checked against every marker that is not part
 * of its own `SHELL_IDENTITY` — and a test below proves that identity really
 * is in its shell, so the exception cannot quietly widen.
 *
 * `path` is what is fetched when it is not the nav URL itself: the flag, report
 * and lead queues show their seeded row under a decided status
 * (`scripts/seed-admin-world.ts` keeps the pending queues as they were).
 *
 * Nav pages without an entry are covered by the reachability check below but
 * not by the leak check, and `uncovered` reports them rather than passing
 * silently.
 */
const ROW_MARKER: Record<string, { markers: string[]; path?: string }> = {
  "/dashboard/users": { markers: ["hemanth.ramesh@blendn.app"] },
  "/dashboard/organisers": { markers: ["daniel.weber@blendn.app", "organizer@blendn.app"] },
  // Two owners since step 14's seed, so venue.owner@ is checked against one
  // that is not itself.
  "/dashboard/venue-owners": { markers: ["kabir.venue@blendn.app", "venue.owner@blendn.app"] },
  "/dashboard/organisations": {
    markers: [
      "Third Wave Coffee Roasters",
      "Nightshift Collective",
      "Indiranagar Hospitality Group",
      "Blue Tokai Coffee Roasters",
    ],
  },
  "/dashboard/onboarding": { markers: ["founder@thehummingtree.com"] },
  "/dashboard/claims": { markers: ["events@toit.in"] },
  "/dashboard/sponsors": { markers: ["Third Wave", "Blue Tokai"] },
  /*
   * The unclaimed venue, deliberately — it is the row the admin index exists
   * to surface, and the one a venue-owner-scoped page can never show.
   */
  "/dashboard/venues": { markers: ["Church Street Social"] },
  /*
   * The subtitle, not the name. "Open Bar" is plausible markup on any screen
   * that lists what an event offers. Seeded by the migration rather than by
   * seed-qa, so it is present in any migrated database — including CI's.
   */
  "/dashboard/amenities": { markers: ["Premium spirits"] },
  /*
   * Step 18: the pages that sat in `STREAMED_OR_UNSEEDED` because the seeded
   * world left them empty. `scripts/seed-admin-world.ts` gives each one row.
   */
  "/dashboard/moderation": { markers: ["98450 12345"], path: "/dashboard/moderation?status=approved" },
  "/dashboard/leads": { markers: [MATRIX_MARKERS.lead], path: "/dashboard/leads?status=all" },
  "/dashboard/creative-review": { markers: [MATRIX_MARKERS.creative] },
  // The placement is agreed and unpriced: the ledger's "unbilled" row.
  "/dashboard/charges": { markers: ["Design Week Bengaluru"] },
  // seed-qa now seeds the taxonomy its events are tagged with.
  "/dashboard/categories": { markers: [MATRIX_MARKERS.category] },
  /*
   * Shared routes: an admin sees the curated listing and the admin's own audit
   * row; the host roles open these pages too, scoped, and the scoped check
   * below holds them to receiving neither.
   */
  "/dashboard/events": { markers: ["Indie Sundowner at Toit"] },
  "/dashboard/audit": { markers: [MATRIX_MARKERS.audit] },
}

/**
 * On a route a host role IS entitled to, these are still not theirs: a curated
 * listing has no organisation, and an admin's audit row has no colleague.
 * Allowed and scoped is not the same as allowed.
 */
const SCOPED_OUT: Record<string, string[]> = {
  "/dashboard/events": ["Indie Sundowner at Toit"],
  "/dashboard/audit": [MATRIX_MARKERS.audit],
  // A venue owner's own "My venues" at the same URL: theirs, never the record
  // index — and not the unclaimed venue their organisation has only claimed.
  "/dashboard/venues": ["Church Street Social"],
}

/**
 * What a role's own shell says on every page it opens: the organisation it
 * acts for. Not a leak for that role; asserted present below. An admin acts
 * for Blend'n, which no marker names, and the outsider acts for nobody.
 */
const SHELL_IDENTITY: Record<(typeof DASHBOARD_ROLES)[number], string[]> = {
  admin: [],
  organizer: ["Nightshift Collective"],
  venue: ["Indiranagar Hospitality Group"],
  sponsor: ["Blue Tokai Coffee Roasters"],
  outsider: [],
}
const ownIdentity = (role: (typeof DASHBOARD_ROLES)[number], marker: string) =>
  SHELL_IDENTITY[role].some((id) => id.includes(marker))

/**
 * Nav pages this technique cannot judge, and why — stated rather than skipped.
 *
 * Every one is a host's own page or a form: there is no other organisation's
 * row on it to leak, so neither half of the check has anything to look for.
 * Who may read whose figures is held by their own specs and itests.
 */
const STREAMED_OR_UNSEEDED = new Set([
  "/dashboard/reports", // a form, not a table
  "/dashboard/attendees", // an organiser's own labels; the identity boundary has its own guard
  "/dashboard/chatrooms", // every role's own rooms; venue-live-ranges.itest.ts holds the venue's view
  "/dashboard/placements",
  "/dashboard/brand",
  "/dashboard/organisation",
  // An organisation's own plan and analytics (step 16): an admin is sent away
  // from both, so the positive control below could not see a marker. Held by
  // analytics-gating.itest.ts and billing-actions.itest.ts.
  "/dashboard/plan",
  "/dashboard/analytics",
])

/**
 * Entitlement for routes deliberately kept out of the nav.
 *
 * `visibleNavFor` is the *sidebar's* answer, and this test treats it as the
 * whole answer — which holds right up until a route is unlisted on purpose.
 * `/dashboard/venue-owners` is admin-only and reachable; it left the sidebar
 * when "Venues" was repointed at the record index.
 */
const UNLISTED_ENTITLEMENT: Record<string, string[]> = {
  "/dashboard/venue-owners": ["app_admin"],
}

/**
 * Fetched exactly as asked. See the docblock: a followed refusal is a
 * different page.
 */
async function fetchRefused(ctx: APIRequestContext, path: string) {
  const res = await ctx.get(path, { maxRedirects: 0 })
  const body = await res.text()
  const status = res.status()
  return { status, body, refused: (status >= 300 && status < 400) || body.includes("NEXT_REDIRECT") }
}

const contextFor = (baseURL: string | undefined, role: RoleKey) =>
  playwrightRequest.newContext({ baseURL, storageState: statePathFor(role) })

test.describe("a role receives only the rows it is entitled to", () => {
  test("no denied page returns its data", async ({ baseURL }) => {
    const leaked: string[] = []
    const uncovered = dashboardNav
      .map((i) => i.url)
      .filter((u) => u !== "/dashboard" && !(u in ROW_MARKER) && !STREAMED_OR_UNSEEDED.has(u))

    for (const role of HOSTS) {
      const ctx = await contextFor(baseURL, role)
      const allowed = new Set(visibleNavFor(ROLE_ACCOUNTS[role].role).map((i) => i.url))

      for (const [url, { markers, path }] of Object.entries(ROW_MARKER)) {
        const entitled = allowed.has(url) || UNLISTED_ENTITLEMENT[url]?.includes(ROLE_ACCOUNTS[role].role)
        // Entitled and scoped: only the rows that are never a host's are checked.
        const forbidden = entitled ? (SCOPED_OUT[url] ?? []) : markers
        if (forbidden.length === 0) continue
        const { body } = await fetchRefused(ctx, path ?? url)
        for (const marker of forbidden) {
          if (ownIdentity(role, marker)) continue
          if (body.includes(marker)) leaked.push(`${role} sees "${marker}" on ${path ?? url}`)
        }
      }
      await ctx.dispose()
    }

    expect(
      { leaked, uncovered },
      "leaked: a role received rows from a page it has no entitlement to. " +
        "uncovered: no row marker declared, so this page's data is not checked — add one to ROW_MARKER."
    ).toEqual({ leaked: [], uncovered: [] })
  })

  test("an admin does receive those rows — or the test above proves nothing", async ({ baseURL }) => {
    /*
     * The positive control, and it is not optional.
     *
     * Every assertion above is a `not.toContain`. If the markers were wrong, or
     * the seed had not run, every one of them would pass against a completely
     * broken app. This is the half that fails when the test is vacuous.
     */
    const ctx = await contextFor(baseURL, "admin")
    const missing: string[] = []
    for (const [url, { markers, path }] of Object.entries(ROW_MARKER)) {
      const body = await (await ctx.get(path ?? url)).text()
      for (const marker of markers) {
        if (!body.includes(marker)) missing.push(`${path ?? url} did not contain "${marker}"`)
      }
    }
    await ctx.dispose()

    expect(
      missing,
      "An admin must see every marker. A miss means the seed did not run, or the marker is stale — " +
        "either way the denial assertions above are passing vacuously."
    ).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */

/**
 * DK-E01 — every admin route, every role (step 18).
 *
 * The nav-based check above covers what the sidebar lists. An admin also works
 * on routes no sidebar names: the sub-queues, the detail pages, and the two
 * old claim URLs that now redirect. Every admin nav entry and each of those is
 * here with the rows only it shows, and each is asked of all six accounts:
 *
 *   admin      sees the rows (the positive control)
 *   organizer, venue, sponsor, outsider
 *              refused — a 3xx, or the shell with a NEXT_REDIRECT — and no
 *              rows; or, where the role has its own page at that URL (Events,
 *              My venues, Audit log…), served its own page and none of the
 *              rows in `SCOPED_OUT`
 *   attendee   bounced by `middleware.ts` before any page runs
 *
 * The detail routes need ids, read from the seeded world: organizer@'s and
 * venue.owner@'s own accounts (their own detail page is still an admin page),
 * and the unclaimed venue, which only an admin may open.
 */
interface AdminRoute {
  route: string
  path: string
  markers: string[]
  /** An old URL that only redirects: an admin is sent here, and the rows are checked there. */
  redirectsTo?: string
}

/**
 * A route a host role also has a page at (Overview, Events, My venues,
 * Chatrooms, Reports, Audit log). There a host may be served its own scoped
 * view rather than refused; what it may never receive is `SCOPED_OUT`. Every
 * other admin route is the admin's alone, and a host must be refused.
 */
const sharedWithHosts = (route: string) =>
  dashboardNav.some((i) => i.url === route && i.allowedRoles.some((r) => r !== "app_admin"))

async function adminRoutes(): Promise<AdminRoute[]> {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }),
  })
  try {
    const [organiser, venueOwner, unclaimed] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: "organizer@blendn.app" }, select: { id: true } }),
      db.user.findUniqueOrThrow({ where: { email: "venue.owner@blendn.app" }, select: { id: true } }),
      db.venues.findFirstOrThrow({ where: { name: "Church Street Social", owner_org_id: null }, select: { id: true } }),
    ])
    const nav = (url: string): AdminRoute => ({
      route: url,
      path: ROW_MARKER[url]?.path ?? url,
      markers: ROW_MARKER[url]?.markers ?? [],
    })
    const sub = (route: string, path: string, markers: string[]): AdminRoute => ({ route, path, markers })
    return [
      // Every destination an admin's sidebar offers, shared ones included.
      ...[...new Set(visibleNavFor("app_admin").map((i) => i.url))].map(nav),
      nav("/dashboard/venue-owners"),
      sub("/dashboard/moderation/reports", "/dashboard/moderation/reports?status=reviewed", [MATRIX_MARKERS.report]),
      sub("/dashboard/claims/venues", "/dashboard/claims/venues", ["Church Street Social"]),
      sub("/dashboard/claims/brands", "/dashboard/claims/brands", ["Third Wave Coffee Roasters"]),
      // The old URLs: each redirects everyone to the queue above, which then
      // decides. Their rows are that queue's rows, checked there.
      { ...sub("/dashboard/venue-claims", "/dashboard/venue-claims", []), redirectsTo: "/dashboard/claims/venues" },
      { ...sub("/dashboard/sponsor-claims", "/dashboard/sponsor-claims", []), redirectsTo: "/dashboard/claims/brands" },
      sub("/dashboard/events/curate", "/dashboard/events/curate", ["Terrace Jazz at Bob's Bar"]),
      sub("/dashboard/organisers/[id]", `/dashboard/organisers/${organiser.id}`, [
        "organizer@blendn.app",
        "Sunset Sessions at The Humming Tree",
      ]),
      sub("/dashboard/venue-owners/[id]", `/dashboard/venue-owners/${venueOwner.id}`, ["venue.owner@blendn.app"]),
      sub("/dashboard/venues/[id] (unclaimed)", `/dashboard/venues/${unclaimed.id}`, ["Church Street Social"]),
    ]
  } finally {
    await db.$disconnect()
  }
}

test.describe("DK-E01: every admin route × every role", () => {
  test("an admin sees each route's rows; every other role is refused and receives none", async ({ baseURL }) => {
    test.setTimeout(180_000)
    const routes = await adminRoutes()
    // Guards the list: a filter that matched nothing would make the rest vacuous.
    expect(routes.length).toBeGreaterThanOrEqual(25)

    const matrix: Record<string, Record<string, string>> = {}
    const wrong: string[] = []

    const admin = await contextFor(baseURL, "admin")
    for (const r of routes) {
      if (r.redirectsTo) {
        const { status, body } = await fetchRefused(admin, r.path)
        const ok = body.includes(`NEXT_REDIRECT;replace;${r.redirectsTo};`)
        matrix[r.route] = { admin: ok ? `redirected → ${r.redirectsTo}` : `WRONG ${status}` }
        if (!ok) wrong.push(`admin on ${r.path}: no redirect to ${r.redirectsTo}`)
        continue
      }
      const res = await admin.get(r.path)
      const body = await res.text()
      const missing = r.markers.filter((m) => !body.includes(m))
      const ok = res.status() === 200 && !body.includes("NEXT_REDIRECT") && missing.length === 0
      const rows = r.markers.length > 0 ? `${r.markers.length} row marker(s) seen` : "rows not checked"
      matrix[r.route] = { admin: ok ? `allowed · ${rows}` : `WRONG ${res.status()} missing ${missing.join(", ")}` }
      if (!ok) wrong.push(`admin on ${r.path}: status ${res.status()}, missing ${JSON.stringify(missing)}`)
    }
    await admin.dispose()

    for (const role of HOSTS) {
      const ctx = await contextFor(baseURL, role)
      // Where the role has its own page at this URL, it is served that page.
      const own = new Set(visibleNavFor(ROLE_ACCOUNTS[role].role).map((i) => i.url))
      for (const r of routes) {
        const { status, body, refused } = await fetchRefused(ctx, r.path)
        const shared = sharedWithHosts(r.route)
        const forbidden = shared ? (SCOPED_OUT[r.route] ?? []) : r.markers
        const seen = forbidden.filter((m) => body.includes(m) && !ownIdentity(role, m))
        // The admin's own routes refuse; a shared one may serve a scoped view.
        const ok = (shared || refused) && seen.length === 0
        const rows = forbidden.length > 0 ? `0 of ${forbidden.length} admin row marker(s)` : "rows not checked"
        const how = refused
          ? r.redirectsTo
            ? `redirected → ${r.redirectsTo}, which refuses`
            : `denied (${status === 200 ? "shell + redirect" : status})`
          : own.has(r.route)
            ? "allowed, own scoped view"
            : "served a scoped view, though not in its nav"
        matrix[r.route][role] = ok ? `${how} · ${rows}` : `WRONG ${status}${seen.length ? ` rows ${seen.join(", ")}` : " not refused"}`
        if (!ok) wrong.push(`${role} on ${r.path}: status ${status}, shared ${shared}, refused ${refused}, rows ${JSON.stringify(seen)}`)
      }
      await ctx.dispose()
    }

    const attendee = await contextFor(baseURL, "attendee")
    for (const r of routes) {
      const res = await attendee.get(r.path, { maxRedirects: 0 })
      const to = res.headers()["location"] ?? ""
      const ok = res.status() >= 300 && res.status() < 400 && !to.startsWith(r.path.split("?")[0])
      matrix[r.route].attendee = ok ? `bounced (${res.status()} → ${to.split("?")[0]})` : `WRONG ${res.status()}`
      if (!ok) wrong.push(`attendee on ${r.path}: status ${res.status()} → ${to}`)
    }
    await attendee.dispose()

    // The deliverable for DK-E01: the matrix itself, in the log.
    console.log(
      "access matrix (route × role):\n" +
        Object.entries(matrix)
          .map(([route, cells]) => `  ${route}\n` + Object.entries(cells).map(([k, v]) => `      ${k.padEnd(9)} ${v}`).join("\n"))
          .join("\n")
    )
    expect(wrong).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */

test("each role's shell carries exactly the identity the leak check excuses", async ({ baseURL }) => {
  /*
   * The exception above is only honest if these strings really are in every
   * page the role opens — otherwise it is an allowlist that hides a leak. Its
   * own overview is the page every role can open.
   */
  const absent: string[] = []
  for (const role of DASHBOARD_ROLES) {
    const ctx = await contextFor(baseURL, role)
    const body = await (await ctx.get("/dashboard")).text()
    for (const id of SHELL_IDENTITY[role]) if (!body.includes(id)) absent.push(`${role}: "${id}"`)
    await ctx.dispose()
  }
  expect(absent).toEqual([])
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

  test("the API reference is admin-only, and says nothing to anyone else", async ({ baseURL, request }) => {
    /*
     * `/api-docs` and `/api/docs` had no check at all: the complete map of the
     * mobile API was readable by anyone who guessed the path. The JSON answers
     * 404 rather than 401 on purpose — "401" tells an anonymous caller that a
     * spec lives here and is merely protected, which is half the disclosure.
     */
    expect((await request.get("/api/docs")).status(), "anonymous").toBe(404)

    const organiser = await contextFor(baseURL, "organizer")
    expect((await organiser.get("/api/docs")).status(), "an organiser has no use for it").toBe(404)
    await organiser.dispose()

    const admin = await contextFor(baseURL, "admin")
    const res = await admin.get("/api/docs")
    expect(res.status(), "an admin must still be able to read it — or this is not a gate, it is a deletion").toBe(200)
    expect((await res.json()).openapi, "and it must still be a spec").toBeTruthy()
    await admin.dispose()
  })

  test("an organiser with no organisation is denied other people's events", async ({ browser }) => {
    const context = await browser.newContext({ storageState: statePathFor("outsider") })
    const page = await context.newPage()
    /*
     * The negative control. A dashboard role with no org — `eventPermissions`
     * denies it everywhere, so empty screens here are the correct answer.
     */
    await page.goto("/dashboard/events", { waitUntil: "domcontentloaded" })
    const body = (await page.textContent("body")) ?? ""
    expect(body).not.toContain("Sunset Sessions at The Humming Tree")
    await context.close()
  })
})
