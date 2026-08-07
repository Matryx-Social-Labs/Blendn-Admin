import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative, resolve } from "path"

/**
 * `/apply` is light, the dashboard is dark, and the two must not drift.
 *
 * A visitor clicks "List your event" on the organiser landing page and is
 * redirected here, so this is the last step of the marketing funnel. It used to
 * render dark — a different company at the exact moment someone is deciding
 * whether to trust us with an application.
 *
 * The fix is a scoped token override, and the risk it carries is drift: someone
 * changes a light value in `:root` and `.apply-light` keeps the old one, so the
 * two themes diverge silently and nobody notices until a screenshot. This
 * asserts every value `.apply-light` re-declares still matches `:root` exactly.
 */

const ROOT = resolve(__dirname, "..")
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8")

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`no ${selector} block in globals.css`)
  const body = css.slice(start, css.indexOf("}", start))
  const out = new Map<string, string>()
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    out.set(m[1], m[2].trim())
  }
  return out
}

describe("the /apply light override", () => {
  const root = block(":root")
  const apply = block(".apply-light")

  it("re-declares values verbatim from :root", () => {
    // Copied, never invented. A value here that :root does not have is a second
    // source of truth for the same colour.
    const drifted: string[] = []
    for (const [token, value] of apply) {
      if (root.get(token) !== value) {
        drifted.push(`${token}: .apply-light has "${value}", :root has "${root.get(token) ?? "nothing"}"`)
      }
    }
    expect(drifted).toEqual([])
  })

  it("does not override the brand colours", () => {
    // `--primary` and `--primary-foreground` are already identical in both
    // themes and already match the landing page's brand-500 on ink. Re-declaring
    // them would add a third place to change the brand colour.
    expect(apply.has("--primary")).toBe(false)
    expect(apply.has("--primary-foreground")).toBe(false)
  })

  it("declares enough to actually flip the theme", () => {
    // Guards the guard: an empty block would pass both tests above.
    for (const token of ["--background", "--foreground", "--card", "--muted-foreground", "--border"]) {
      expect(apply.has(token)).toBe(true)
    }
  })
})

describe("the override stays in its subtree", () => {
  it("is used only by the apply funnel", () => {
    // If `.apply-light` ever lands on a dashboard element, the dashboard goes
    // light — which is the one thing the brief's acceptance criteria forbid.
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(tsx?|css)$/.test(entry) && readFileSync(full, "utf8").includes("apply-light")) {
          hits.push(relative(ROOT, full))
        }
      }
    }
    for (const dir of ["app", "components", "lib"]) walk(join(ROOT, dir))

    expect(hits.sort()).toEqual([
      "app/apply/page.tsx",
      "app/apply/verify/page.tsx",
      "app/globals.css",
    ])
  })
})
