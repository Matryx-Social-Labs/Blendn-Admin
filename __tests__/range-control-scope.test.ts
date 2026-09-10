import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative, sep } from "path"

/**
 * The date-range control renders exactly where a range is read.
 *
 * It used to render everywhere except a hand-kept deny-list of twenty
 * "timeless" screens. Three pages call `resolveRange`; the control appeared on
 * **19 routes that read no range at all** — `/dashboard/users`,
 * `/dashboard/events`, `/dashboard/moderation`, and every `[id]` page, which an
 * exact-match Set could never have covered.
 *
 * Driven rather than inferred: `/dashboard/users` at `?range=today` and
 * `?range=90d` renders four byte-identical tiles, each already carrying its own
 * fixed window — "26 new this month", "vs last month". Clicking 90d there does
 * nothing and says nothing.
 *
 * The deny-list defaulted the wrong way: a new screen inherited a control that
 * probably did not work. This guard is what makes the inverted default hold —
 * add a page that reads a range without listing it and the build fails, and
 * list one that does not and the build fails too.
 */
const ROOT = join(__dirname, "..")
const DASHBOARD = join(ROOT, "app", "dashboard")

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/** Every `page.tsx` under `app/dashboard`, as its route. */
function dashboardRoutes(): { route: string; readsRange: boolean }[] {
  const out: { route: string; readsRange: boolean }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (entry === "page.tsx") {
        const src = stripComments(readFileSync(abs, "utf8"))
        const route =
          "/dashboard/" + relative(DASHBOARD, dir).split(sep).join("/")
        out.push({
          route: route.replace(/\/$/, "").replace("/dashboard/.", "/dashboard"),
          readsRange: /\bresolveRange\s*\(/.test(src),
        })
      }
    }
  }
  walk(DASHBOARD)
  return out
}

const HEADER = stripComments(
  readFileSync(join(ROOT, "components", "site-header.tsx"), "utf8")
)

/** The literal routes in `RANGED`, plus the one pattern beside it. */
function declaredRanged(): { exact: string[]; pattern: RegExp | null } {
  const set = HEADER.match(/const RANGED = new Set\(\[([\s\S]*?)\]\)/)
  const exact = set ? [...set[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []
  const pat = HEADER.match(/const RANGED_VENUE_DETAIL = (\/.+\/)\s*$/m)
  return { exact, pattern: pat ? new RegExp(pat[1].slice(1, -1)) : null }
}

describe("the range control renders only where a range is read", () => {
  const routes = dashboardRoutes()
  const { exact, pattern } = declaredRanged()

  it("found both lists, so the assertions below are not vacuous", () => {
    /*
     * If either regex stopped matching, an empty result would make every
     * assertion pass by having nothing to compare — the failure mode this file
     * exists to prevent in the product.
     */
    expect(routes.length).toBeGreaterThan(20)
    expect(exact.length).toBeGreaterThan(0)
    expect(pattern).not.toBeNull()
    expect(routes.some((r) => r.readsRange)).toBe(true)
  })

  it("shows it on every page that reads a range", () => {
    const shown = (route: string) =>
      exact.includes(route) ||
      (pattern!.test(route.replace(/\[\w+\]/g, "x")) && route !== "/dashboard/venues/new")

    const missing = routes.filter((r) => r.readsRange && !shown(r.route)).map((r) => r.route)
    expect(missing).toEqual([])
  })

  it("shows it on no page that ignores one", () => {
    /*
     * The direction that was broken. Nineteen routes rendered a control that
     * changed nothing on them.
     */
    const shown = (route: string) =>
      exact.includes(route) ||
      (pattern!.test(route.replace(/\[\w+\]/g, "x")) && route !== "/dashboard/venues/new")

    const spurious = routes.filter((r) => !r.readsRange && shown(r.route)).map((r) => r.route)
    expect(spurious).toEqual([])
  })
})
