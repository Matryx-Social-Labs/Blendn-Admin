import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative, sep } from "path"

/**
 * Every dashboard route names itself.
 *
 * `components/site-header.tsx` owns the only `h1` on every dashboard page —
 * both curation screens carry a comment saying so, and two other pages used to
 * render a second one. That makes the header's title the first thing a screen
 * reader announces, and the last thing anyone thinks to check, because the body
 * of the page looks correct either way.
 *
 * It resolves that title from an exact `routeContent` lookup, then falls
 * through to two prefix rules and finally to a generic "Overview". Both of the
 * fallbacks are wrong for a route that simply forgot an entry:
 *
 *   - `/dashboard/events/curate` matched `startsWith("/dashboard/events/")`,
 *     so the curation screen announced itself as **"Event — Setup, performance,
 *     and what happened on the night."** — the event *detail* header, on a
 *     screen that is not about one event.
 *   - `/dashboard/claims`, `/dashboard/claims/venues`,
 *     `/dashboard/moderation/reports`, `/dashboard/leads` and
 *     `/dashboard/venues/new` matched nothing and fell to **"Overview — Live
 *     reporting across growth, attendance, and event activity."**
 *
 * None of that is visible to `tsc`, to a unit test, or to `next build`. It was
 * found by opening the page in a browser, which is the one thing the loop this
 * project runs does not do — so this test is what stops the next route from
 * repeating it.
 *
 * The rule is deliberately blunt: **a static dashboard route must have an exact
 * entry.** Dynamic routes (`[id]`) are what the prefix fallbacks exist for and
 * are exempt. There is no allowlist, because an allowlist here would be a
 * record of pages that announce themselves incorrectly on purpose.
 */

const ROOT = join(__dirname, "..")
const DASHBOARD = join(ROOT, "app", "dashboard")

/** Routes that redirect before rendering, so no header is ever shown. */
const REDIRECT_ONLY = new Set(["/dashboard/venue-claims"])

/** The overview branches on role inside the component, above the lookup. */
const RESOLVED_IN_CODE = new Set(["/dashboard"])

function staticRoutes(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // A dynamic segment makes every route beneath it dynamic.
      if (entry.startsWith("[")) continue
      staticRoutes(full, acc)
    } else if (entry === "page.tsx") {
      const rel = relative(join(ROOT, "app"), dir)
      acc.push("/" + rel.split(sep).join("/"))
    }
  }
  return acc
}

const header = readFileSync(join(ROOT, "components", "site-header.tsx"), "utf8")

/**
 * Keys of the `routeContent` map, read from source rather than imported — the
 * module is a client component and pulls in `next-auth/react`.
 */
const entries = new Set(
  Array.from(header.matchAll(/"(\/dashboard[^"]*)":\s*\{/g), (m) => m[1])
)

describe("every static dashboard route has a header title", () => {
  const routes = staticRoutes(DASHBOARD).sort()

  it("finds the routes at all", () => {
    // Guards the walker itself: a broken walk would make the suite below
    // vacuously pass, which is the exact failure R16's controls exist to catch.
    expect(routes).toContain("/dashboard/events/curate")
    expect(routes).toContain("/dashboard/claims")
    expect(routes.length).toBeGreaterThan(15)
  })

  it("parsed the route map at all", () => {
    expect(entries.size).toBeGreaterThan(15)
  })

  it.each(routes)("%s", (route) => {
    if (REDIRECT_ONLY.has(route) || RESOLVED_IN_CODE.has(route)) return
    expect(entries.has(route)).toBe(true)
  })
})

describe("the fallbacks stay generic, so a missing entry stays wrong", () => {
  it("still falls through to Overview rather than guessing", () => {
    // If the fallback ever gets clever -- deriving a title from the path, say --
    // the suite above stops meaning anything, because every route would get a
    // plausible title and none would be reviewed.
    expect(header).toContain('title: "Overview"')
  })
})

describe("site-header owns the only h1", () => {
  /**
   * A ratchet, not a pass: these five render their own `h1` *as well as* the
   * header's, so a screen reader announces two. That predates the curation work
   * and fixing nine files (five static, four dynamic) does not belong in it —
   * but the list may only shrink, which is why the second assertion below
   * fails on a stale entry.
   *
   * Two pages left this list already: `/dashboard/leads` and
   * `/dashboard/venues/new` were demoted to `h2` in the same change that gave
   * them a header entry, because a page with a wrong `h1` *and* a right one is
   * the confusing case, not merely the untidy one.
   */
  const KNOWN_DOUBLE_H1 = [
    "/dashboard/chatrooms",
    "/dashboard/events",
    "/dashboard/organisers",
    "/dashboard/users",
    "/dashboard/venue-owners",
  ]

  const pages = staticRoutes(DASHBOARD)

  it.each(pages.filter((r) => !KNOWN_DOUBLE_H1.includes(r)))(
    "%s renders no h1 of its own",
    (route) => {
      const file = join(ROOT, "app", route.slice(1), "page.tsx")
      expect(readFileSync(file, "utf8")).not.toMatch(/<h1[\s>]/)
    }
  )

  it.each(KNOWN_DOUBLE_H1)("%s is still on the list for a reason", (route) => {
    // Delete the entry when you fix the page. A ratchet nobody prunes becomes
    // an allowlist, and this repo has already paid for one of those in a merge.
    const file = join(ROOT, "app", route.slice(1), "page.tsx")
    expect(readFileSync(file, "utf8")).toMatch(/<h1[\s>]/)
  })
})
