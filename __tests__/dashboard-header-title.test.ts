import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, relative, sep } from "path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

const mockPathname = { current: "/dashboard" }
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname.current,
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

import { PageHeader } from "@/components/dashboard/page-header"
import { RoutePageHeader } from "@/components/dashboard/route-page-header"
import {
  OWNED_HEADERS,
  breadcrumbsFor,
  ownsHeader,
  routeContent,
  routeHeading,
} from "@/lib/dashboard-route-content"

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
 * Except the routes in `OWNED_HEADERS` — one record each, named by the record
 * — where `RoutePageHeader` renders nothing and the page renders its own
 * `PageHeader`, server-side and first. So the rule has two halves, both held
 * below: an owned route's page renders exactly one `PageHeader`, and every
 * other page renders none.
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

  it.each([
    ["/dashboard", "organizer", ["Org", "Overview"]],
    ["/dashboard/events/e1/messaging", "organizer", ["Org", "Events", "Event", "Room chat"]],
    ["/dashboard/events/e1/edit", "organizer", ["Org", "Events", "Event", "Edit event"]],
    ["/dashboard/events/e1/feedback", "venue_owner", ["Org", "Events", "Event", "Feedback"]],
    ["/dashboard/venues/v1/claim", "venue_owner", ["Org", "Venues", "Venue", "Claim a venue"]],
    ["/dashboard/organisers/o1", "app_admin", ["Org", "Organisers", "Organiser"]],
    ["/dashboard/venue-owners/o1", "app_admin", ["Org", "Venue owners", "Venue owner"]],
    ["/dashboard/moderation/reports", "app_admin", ["Org", "Moderation", "Reports"]],
    ["/dashboard/claims/brands", "app_admin", ["Org", "Claims"]],
    ["/dashboard/events/new", "organizer", ["Org", "Events", "New event"]],
  ] as const)("%s reads as its trail", (path, role, trail) => {
    expect(breadcrumbsFor(path, role, "Org").map((c) => c.label)).toEqual(trail)
  })

  it("links every crumb but the last to a page that exists", () => {
    /** `/dashboard/events/e1` -> app/dashboard/events/[id]/page.tsx, if it exists. */
    const resolves = (href: string) => {
      let dir = join(ROOT, "app")
      for (const seg of href.split("/").filter(Boolean)) {
        const exact = join(dir, seg)
        if (existsSync(exact) && statSync(exact).isDirectory()) {
          dir = exact
          continue
        }
        const dynamic = readdirSync(dir).find((e) => e.startsWith("["))
        if (!dynamic) return false
        dir = join(dir, dynamic)
      }
      return existsSync(join(dir, "page.tsx"))
    }
    const paths = [
      "/dashboard/events/e1/messaging",
      "/dashboard/events/e1/feedback",
      "/dashboard/venues/v1/claim",
      "/dashboard/organisers/o1",
      "/dashboard/venue-owners/o1",
      "/dashboard/moderation/reports",
      "/dashboard/claims/venues",
    ]
    for (const path of paths) {
      const crumbs = breadcrumbsFor(path, "app_admin", "Org")
      expect(crumbs.at(-1)!.href).toBeUndefined()
      for (const c of crumbs.slice(0, -1)) expect({ href: c.href, resolves: resolves(c.href!) }).toEqual({ href: c.href, resolves: true })
    }
  })

  it("does not let an organisation named like a section swallow it", () => {
    expect(breadcrumbsFor("/dashboard/events/e1", "organizer", "Events").map((c) => c.label)).toEqual([
      "Events",
      "Events",
      "Event",
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

  it("RoutePageHeader names a layout-named route, and stands down on an owned one", () => {
    mockPathname.current = "/dashboard/users"
    expect(renderToStaticMarkup(createElement(RoutePageHeader, { role: "app_admin" }))).toMatch(
      /<h1[^>]*>Users<\/h1>/
    )
    mockPathname.current = "/dashboard/events/e1"
    expect(renderToStaticMarkup(createElement(RoutePageHeader, { role: "organizer" }))).toBe("")
  })

  /**
   * The page file AND the local components it renders, one hop.
   *
   * This read `page.tsx` alone, and `/dashboard/events/new` rendered a second
   * `h1` reading "Create Event" from `components/event-editor.tsx` — one import
   * away, invisible to the guard. One hop rather than a full graph walk: a
   * page's own header lives in the component the page renders, not four levels
   * down. The whole-tree scan below covers the rest.
   */
  function ownAndImported(file: string): string[] {
    const src = readFileSync(file, "utf8")
    const out = [src]
    for (const m of src.matchAll(/from\s+"@\/(components\/[\w./-]+)"/g)) {
      // The header itself is what an owned page imports to render one.
      if (m[1] === "components/dashboard/page-header") continue
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
  /** `app/dashboard/events/[id]/page.tsx` -> `/dashboard/events/x`. */
  const routeOf = (page: string) =>
    "/" + page.replace(/^app\//, "").replace(/\/page\.tsx$/, "").split(sep).join("/").replace(/\[\w+\]/g, "x")
  const owned = pages.filter((p) => ownsHeader(routeOf(p)))
  const count = (src: string, re: RegExp) => (src.match(re) ?? []).length

  it("found the pages, and the owned ones", () => {
    expect(pages).toContain(join("app", "dashboard", "events", "[id]", "page.tsx"))
    expect(pages.length).toBeGreaterThan(30)
    // Every pattern names at least one page, so none is a stale entry.
    for (const re of OWNED_HEADERS) {
      expect({ re: String(re), pages: owned.filter((p) => re.test(routeOf(p))).length > 0 }).toEqual({
        re: String(re),
        pages: true,
      })
    }
    expect(owned).toHaveLength(8)
  })

  it.each(pages)("%s renders the h1 its route calls for", (page) => {
    const sources = ownAndImported(join(ROOT, page))
    const headers = sources.reduce((n, src) => n + count(src, /<PageHeader[\s>]/g), 0)
    const h1s = sources.reduce((n, src) => n + count(src, /<h1[\s>]/g), 0)
    expect({ page, h1s, headers }).toEqual({ page, h1s: 0, headers: owned.includes(page) ? 1 : 0 })
  })

  // That the owned header is the page's FIRST child is measured where it can
  // be — rendered, in e2e/dashboard-shell.spec.ts.
})

describe("no h1 anywhere else in the dashboard tree", () => {
  /**
   * The one-hop read above misses an h1 two components down. The dashboard has
   * exactly one component allowed to draw one; everything else in
   * `app/dashboard` and `components` is checked, however deep.
   */
  function files(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) files(full, acc)
      else if (/\.tsx?$/.test(entry)) acc.push(full)
    }
    return acc
  }
  const tree = [...files(DASHBOARD), ...files(join(ROOT, "components"))].map((f) => relative(ROOT, f))

  it("walked the tree", () => {
    expect(tree.length).toBeGreaterThan(150)
  })

  it("finds an h1 only in PageHeader", () => {
    const withH1 = tree.filter((f) => /<h1[\s>]/.test(readFileSync(join(ROOT, f), "utf8")))
    // `components/` is shared with the public pages, whose frames draw their
    // page's one h1 (step 18). Allowed because `apply-theme.test.ts` keeps
    // every importer of public-frame outside the dashboard.
    expect(withH1).toEqual([join("components", "dashboard", "page-header.tsx"), join("components", "public-frame.tsx")])
  })
})

describe("every dashboard page names its tab", () => {
  /*
   * WCAG 2.4.2. Without these every tab read "Blend'n Admin", whatever was in
   * it. Static pages take the h1's word from `routeMetadata`; owned pages
   * read the record's name through a loader that applies the page's own
   * access rule (`lib/dashboard-record-titles.ts`).
   */
  const pages = allPages(DASHBOARD).map((f) => relative(ROOT, f))

  it.each(pages)("%s exports metadata or generateMetadata", (page) => {
    expect(read(page)).toMatch(/export const metadata\b|export async function generateMetadata\b/)
  })
})
