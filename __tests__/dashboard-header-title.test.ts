import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, relative, sep } from "path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { PageHeader } from "@/components/dashboard/page-header"
import { breadcrumbsFor, routeContent, routeHeading } from "@/lib/dashboard-route-content"

/**
 * Every dashboard page has exactly one `h1`, it names the page, and it is
 * inside `main`.
 *
 * ## Where the h1 lives (R5)
 *
 * The layout renders `RoutePageHeader` as the first thing in `<main>`, and it
 * renders `PageHeader`, which holds the `h1`. The top bar shows breadcrumbs and
 * no heading. Both read `lib/dashboard-route-content.ts`, so the last crumb and
 * the heading are the same word.
 *
 * It used to be the top bar's `h1`, outside `main`: a screen reader's "jump to
 * main" landed past the page's name, and the title sat a hairline away from the
 * actions it governs.
 *
 * ## Every static route names itself
 *
 * The title is an exact `routeContent` lookup, then two prefix rules, then a
 * generic "Overview". Both fallbacks are wrong for a route that simply forgot
 * an entry:
 *
 *   - `/dashboard/events/curate` matched `startsWith("/dashboard/events/")`,
 *     so the curation screen announced itself as **"Event — Setup, performance,
 *     and what happened on the night."**
 *   - `/dashboard/claims`, `/dashboard/claims/venues`,
 *     `/dashboard/moderation/reports`, `/dashboard/leads` and
 *     `/dashboard/venues/new` matched nothing and fell to **"Overview"**.
 *
 * None of that is visible to `tsc`, to a unit test, or to `next build`. So the
 * rule is blunt: **a static dashboard route must have an exact entry.** Dynamic
 * routes (`[id]`) are what the prefix rules exist for and are exempt. There is
 * no allowlist, because an allowlist here would be a record of pages that
 * announce themselves incorrectly on purpose.
 *
 * The browser half — one `h1` on the rendered page, inside `main`, for every
 * role — is `e2e/dashboard-shell.spec.ts`.
 */

const ROOT = join(__dirname, "..")
const DASHBOARD = join(ROOT, "app", "dashboard")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

/** Routes that redirect before rendering, so no header is ever shown. */
const REDIRECT_ONLY = new Set(["/dashboard/venue-claims"])

/** The overview branches on role inside `routeHeading`, above the lookup. */
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

/** Every page, dynamic ones included: they get the layout's h1 too. */
function allPages(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) allPages(full, acc)
    else if (entry === "page.tsx") acc.push(full)
  }
  return acc
}

describe("every static dashboard route has a heading", () => {
  const routes = staticRoutes(DASHBOARD).sort()
  const entries = new Set(Object.keys(routeContent))

  it("finds the routes at all", () => {
    // Guards the walker itself: a broken walk would make the suite below
    // vacuously pass, which is the exact failure R16's controls exist to catch.
    expect(routes).toContain("/dashboard/events/curate")
    expect(routes).toContain("/dashboard/claims")
    expect(routes.length).toBeGreaterThan(15)
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
    expect(routeHeading("/dashboard/not-a-route", "organizer").title).toBe("Overview")
  })
})

describe("the breadcrumbs and the heading are one source", () => {
  it("ends the trail on the page's own heading, unlinked", () => {
    for (const [path, role] of [
      ["/dashboard/events/curate", "app_admin"],
      ["/dashboard/events/e1/messaging", "organizer"],
      ["/dashboard/venues/v1/claim", "venue_owner"],
      ["/dashboard/organisation", "sponsor"],
    ] as const) {
      const crumbs = breadcrumbsFor(path, role, "Org")
      expect(crumbs.at(-1)).toEqual({ label: routeHeading(path, role).title })
    }
  })

  it("starts with the organisation, linking to the overview", () => {
    expect(breadcrumbsFor("/dashboard/events/e1", "organizer", "Indie Collective")).toEqual([
      { label: "Indie Collective", href: "/dashboard" },
      { label: "Events", href: "/dashboard/events" },
      { label: "Event" },
    ])
  })

  it("does not repeat a level that names the same screen", () => {
    expect(breadcrumbsFor("/dashboard/claims/venues", "app_admin", "Blend'n")).toEqual([
      { label: "Blend'n", href: "/dashboard" },
      { label: "Claims" },
    ])
  })
})

describe("the content area owns the only h1", () => {
  it("PageHeader renders exactly one h1, holding the title", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, { title: "Chatrooms", description: "Every open room." })
    )
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1)
    expect(html).toMatch(/<h1[^>]*>Chatrooms<\/h1>/)
  })

  it("the layout puts the route's PageHeader inside main", () => {
    const layout = read("app/dashboard/layout.tsx")
    const main = layout.match(/<main[\s>][\s\S]*?<\/main>/)
    expect(main).not.toBeNull()
    expect(main![0]).toContain("<RoutePageHeader")
  })

  it("the top bar renders no heading", () => {
    expect(read("components/site-header.tsx")).not.toMatch(/<h1[\s>]|<PageHeader[\s>]/)
  })

  /**
   * The page file AND the local components it renders, one hop.
   *
   * This read `page.tsx` alone, and `/dashboard/events/new` rendered a second
   * `h1` reading "Create Event" from `components/event-editor.tsx` — one import
   * away, invisible to the guard. One hop rather than a full graph walk: a
   * page's own header lives in the component the page renders, not four levels
   * down.
   *
   * `<PageHeader` counts as an h1. Until a page can tell the layout to stand
   * its header down, a page rendering its own would make two.
   */
  function ownAndImported(file: string): string[] {
    const src = readFileSync(file, "utf8")
    const out = [src]
    for (const m of src.matchAll(/from\s+"@\/(components\/[\w./-]+)"/g)) {
      for (const ext of [".tsx", ".ts", "/index.tsx"]) {
        const dep = join(ROOT, m[1] + ext)
        if (existsSync(dep)) {
          out.push(readFileSync(dep, "utf8"))
          break
        }
      }
    }
    return out
  }

  const pages = allPages(DASHBOARD).map((f) => relative(ROOT, f))

  it("found the pages, dynamic ones included", () => {
    expect(pages).toContain(join("app", "dashboard", "events", "[id]", "page.tsx"))
    expect(pages.length).toBeGreaterThan(30)
  })

  it.each(pages)("%s renders no h1 of its own", (page) => {
    for (const src of ownAndImported(join(ROOT, page))) {
      expect(src).not.toMatch(/<h1[\s>]|<PageHeader[\s>]/)
    }
  })
})
