import { existsSync } from "fs"
import { join } from "path"

import { dashboardNav, unlistedRoutes } from "@/lib/dashboard-nav"
import { routeContent } from "@/lib/dashboard-route-content"

/**
 * Every nav entry points at a page that exists, and has a title.
 *
 * ## Why this exists
 *
 * I added two sponsor nav items — Placements and Brand — before building either
 * screen. A sponsor logging in would have seen both in the sidebar and got a 404
 * from each. Nothing failed: `tsc` cannot see it (the url is a string),
 * `dashboard-view.test.ts` asserts the nav CONTENTS and not that the targets
 * resolve, and no test in this repo renders a route.
 *
 * That is the same declared-but-unreachable shape this codebase has now produced
 * five times — `may_sponsor` with no writer, `canSendSystemMessages` with no
 * caller, `likeAtEvent` with no caller, `stopAllOpsBroadcasts` with no caller.
 * Every one shipped green.
 *
 * Two rules, because a link can be broken in two directions:
 *
 *   1. the nav url must resolve to a `page.tsx`
 *   2. the url must have an entry in `routeContent`
 *      (`lib/dashboard-route-content.ts`), which names the page's only `h1`
 *      and falls through to the title "Overview" for anything it does not know
 *
 * Rule 2 is the quieter failure: the page loads, and it is called Overview.
 */

const ROOT = join(__dirname, "..")

/** `/dashboard/foo/bar` -> `app/dashboard/foo/bar/page.tsx`. */
function pageFileFor(url: string): string {
  return join(ROOT, "app", ...url.split("/").filter(Boolean), "page.tsx")
}

const navUrls = dashboardNav.map((item) => item.url)

describe("nav targets resolve", () => {
  it("finds nav items at all, so this cannot pass vacuously", () => {
    expect(navUrls.length).toBeGreaterThan(5)
  })

  it.each(navUrls)("%s has a page", (url) => {
    expect(existsSync(pageFileFor(url))).toBe(true)
  })

  it.each([...unlistedRoutes])("%s has a page (unlisted but reachable)", (url) => {
    expect(existsSync(pageFileFor(url))).toBe(true)
  })
})

describe("nav targets have a title", () => {
  it.each(navUrls)("%s is named in routeContent", (url) => {
    /*
     * `routeContent` is a hard-coded map that falls through to "Overview". A
     * missing entry does not error — the page renders with the wrong name in
     * the document's only landmark heading, which is worse than a 404 because
     * nobody reports it.
     */
    // The overview is named in code, per role, above the lookup.
    expect(url === "/dashboard" || url in routeContent).toBe(true)
  })
})
