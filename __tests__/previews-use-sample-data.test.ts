import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * MN-G02: a locked preview is drawn from the static sample, never from the
 * organisation's figures under a blur.
 *
 * `Locked` blurs with CSS. Whatever it is given is in the HTML, the RSC
 * payload and the page source, so "Analytics" would be a stylesheet away from
 * free, and a preview built from real rows would sidestep the privacy floors.
 * The owner ruled it (2026-10-01): previews use static sample data.
 *
 * Three things are held here:
 *
 *   1. every `<Locked … sample={…}>` anywhere in app/ or components/ passes a
 *      sample whose data props are `SAMPLE_*` constants and nothing else;
 *   2. `lib/sample-analytics.ts` imports types only, so the sample cannot be
 *      computed from anything;
 *   3. the panels that draw both real and sample figures import the query
 *      module for its types only, so they cannot fetch on their own.
 *
 * Brace-matched, never `[^}]*` (playbook §2): a sample is nested JSX.
 */

const ROOT = join(__dirname, "..")

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx$/.test(entry)) out.push(full)
  }
  return out
}

/** The text of the `{…}` that opens at `open`, braces matched. */
function braced(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error("unbalanced braces")
}

/** Every `sample={…}` given to a `<Locked`, with the file it is in. */
function samples(): { file: string; expr: string }[] {
  const out: { file: string; expr: string }[] = []
  for (const abs of [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]) {
    const file = relative(ROOT, abs)
    if (file === "components/dashboard/kit.tsx") continue
    const src = stripComments(readFileSync(abs, "utf8"))
    for (const m of src.matchAll(/<Locked\b/g)) {
      const at = src.indexOf("sample={", m.index)
      if (at === -1) throw new Error(`${file}: <Locked> without a sample`)
      out.push({ file, expr: braced(src, at + "sample=".length) })
    }
  }
  return out
}

/**
 * Every value a sample expression could carry that is not a SAMPLE_ constant.
 * Strings, JSX tag names, attribute names, object keys and the constants are
 * removed; any identifier left is data from somewhere else — a prop, a spread,
 * a nested object, a variable (G13).
 */
export function foreignValues(expr: string): string[] {
  const rest = expr
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " ")
    .replace(/\bSAMPLE_[A-Z_]+(?:\.[A-Za-z_]\w*)*/g, " ")
    .replace(/<\/?[A-Z][\w.]*/g, " ")
    .replace(/\b[A-Za-z_]\w*\s*=(?!=)/g, " ")
    .replace(/\b[A-Za-z_]\w*\s*:/g, " ")
  return (rest.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []).filter((w) => !["true", "false", "null", "undefined"].includes(w))
}

describe("locked previews use the static sample", () => {
  const found = samples()

  it("finds the Analytics page's previews, so this is not checking nothing", () => {
    expect(found.filter((s) => s.file === "app/dashboard/analytics/page.tsx").length).toBeGreaterThanOrEqual(2)
  })

  it("finds the venue page's Venue Pro previews too (step 17)", () => {
    expect(found.filter((s) => s.file === "app/dashboard/venues/[id]/page.tsx").length).toBeGreaterThanOrEqual(2)
  })

  it("passes only SAMPLE_ constants into every preview", () => {
    const leaks = found.flatMap(({ file, expr }) => foreignValues(expr).map((v) => `${file}: sample gets ${v}`))
    expect(leaks).toEqual([])
  })

  it.each([
    ["a prop", "<OrgPanels data={view.org} />", ["view", "org"]],
    ["a fallback", "<OrgPanels data={view.org ?? SAMPLE_ORG_ANALYTICS} />", ["view", "org"]],
    ["a spread", "<OrgPanels {...props} />", ["props"]],
    ["a nested object", "<OrgPanels data={{ ...SAMPLE_ORG_ANALYTICS, comparison: real.rows }} />", ["real", "rows"]],
  ])("the detector catches %s (G13)", (_label, expr, words) => {
    expect(foreignValues(expr)).toEqual(expect.arrayContaining(words))
  })

  it("the detector passes the sample itself", () => {
    expect(foreignValues("<OrgPanels data={SAMPLE_ORG_ANALYTICS} />")).toEqual([])
    expect(foreignValues('<EventPassPanels data={SAMPLE_EVENT_ANALYTICS} label="x" />')).toEqual([])
  })

  it("builds the sample from nothing: lib/sample-analytics.ts imports types only", () => {
    const src = stripComments(readFileSync(join(ROOT, "lib/sample-analytics.ts"), "utf8"))
    const imports = [...src.matchAll(/^import\s+(type\s+)?/gm)]
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((m) => !m[1])).toEqual([])
  })

  it.each([
    ["components/dashboard/analytics-panels.tsx", /^import\s+(type\s+)?[^;\n]*from\s+"@\/lib\/(org-analytics|analytics-access|entitlements|db)"/gm],
    // Step 17: a venue's insight panels, drawn for real figures and for the sample alike.
    ["components/dashboard/venue-insights-panels.tsx", /^import\s+(type\s+)?[^;\n]*from\s+"@\/lib\/(venue-insights|venue-plan|entitlements|db)"/gm],
  ])("draws from props alone: %s takes the query module's types and nothing else", (file, pattern) => {
    const src = stripComments(readFileSync(join(ROOT, file), "utf8"))
    const fromQueries = [...src.matchAll(pattern)]
    expect(fromQueries.length).toBeGreaterThan(0)
    expect(fromQueries.filter((m) => !m[1]).map((m) => m[0])).toEqual([])
  })
})
