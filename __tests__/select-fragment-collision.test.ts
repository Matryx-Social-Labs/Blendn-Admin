import { readFileSync, readdirSync } from "fs"
import { join, sep } from "path"

/**
 * A select fragment may not claim a key another fragment in the same object
 * already claims.
 *
 * ## Why this exists
 *
 * The resolver-plus-select pattern is the good idea this codebase is built on:
 * a module owns a question *and the columns it needs to answer it*, so a route
 * cannot fetch a half-populated object and get a confidently wrong answer.
 * `eventPermissionSelect` is the original, and CLAUDE.md states the failure it
 * prevents — "a select missing `venue` reads as no venue and silently denies a
 * venue owner".
 *
 * Spreading two fragments into one object reintroduces that failure by a new
 * route. `{ ...a, ...b }` is last-wins, so if both claim `venue` one fragment's
 * nested select disappears and the resolver that needed it sees an object that
 * typechecks, has the right shape, and is missing a relation. Not omission this
 * time — collision.
 *
 * **It has happened three times**: `broadcastAuthorSelect` reaching through
 * `venue`, `eventHostSelect` claiming `organizer`, and `curationSelect`
 * claiming `start_time`. Twice `tsc` caught it with TS2783, and that is luck
 * rather than protection: TS only objects when the two spreads have
 * *incompatible* types. Two fragments that both select a relation with
 * different nested columns are perfectly assignable to each other, so the
 * overwrite is silent — and a relation is exactly where it costs the most.
 *
 * ## The latent one this guard is really for
 *
 * `eventPermissionSelect` claims `venue`. `fenceSelect` also claims `venue`.
 * Nothing spreads both today, and the day something does, whichever goes second
 * wins and the other resolver quietly loses a relation. That is the CLAUDE.md
 * trap arriving through collision instead of omission, and there would be no
 * type error and no failing test.
 */

const ROOT = join(__dirname, "..")

/**
 * Sites where a key is claimed twice on purpose.
 *
 * May shrink, must not grow. An entry needs the reason in the code, not only
 * here — a duplicate that is safe today is safe because of an ordering somebody
 * chose, and an ordering nobody wrote down is an ordering somebody will change.
 */
const ALLOWED: Record<string, string> = {
  "app/dashboard/events/[id]/page.tsx": [
    "curationSelect is spread FIRST and the duplicated keys (start_time,",
    "end_time, organizer_org_id) are the identical `true` either way. The",
    "ordering is what makes that safe rather than lucky, and the file says so.",
  ].join(" "),
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, acc)
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) acc.push(full)
  }
  return acc
}

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

/**
 * The body between `src[start]` and its matching brace.
 *
 * Brace-matched rather than a negated character class. Four guards in this repo
 * have been vacuous for using `[^}]*` to cross a delimiter, and every one was
 * caught by running its control instead of by reading it.
 */
function braceBody(src: string, start: number): { body: string; end: number } | null {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return { body: src.slice(start + 1, i), end: i }
    }
  }
  return null
}

/** Top-level entries of an object body: either a spread or a key. */
function topLevelEntries(body: string): Array<{ kind: "spread" | "key"; name: string }> {
  const out: Array<{ kind: "spread" | "key"; name: string }> = []
  const push = (chunk: string) => {
    const m = /^\s*(?:\.\.\.(\w+)|(\w+)\s*:)/.exec(chunk)
    if (!m) return
    if (m[1]) out.push({ kind: "spread", name: m[1] })
    else out.push({ kind: "key", name: m[2] })
  }
  let depth = 0
  let buf = ""
  for (const ch of body) {
    if (ch === "{" || ch === "[" || ch === "(") depth++
    else if (ch === "}" || ch === "]" || ch === ")") depth--
    if (depth === 0 && ch === ",") {
      push(buf)
      buf = ""
    } else {
      buf += ch
    }
  }
  push(buf)
  return out
}

const files = [...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "app"))]

/** Every exported `*Select` fragment, and the top-level keys it claims. */
const fragments: Record<string, string[]> = {}
for (const file of files) {
  const src = strip(readFileSync(file, "utf8"))
  for (const m of src.matchAll(/export const (\w*[Ss]elect)\s*=\s*\{/g)) {
    const found = braceBody(src, m.index! + m[0].length - 1)
    if (!found) continue
    fragments[m[1]] = topLevelEntries(found.body)
      .filter((e) => e.kind === "key")
      .map((e) => e.name)
  }
}

interface Collision {
  file: string
  line: number
  key: string
  claimedBy: string[]
}

function collisions(): Collision[] {
  const out: Collision[] = []
  for (const file of files) {
    const src = strip(readFileSync(file, "utf8"))
    const rel = file.slice(ROOT.length + 1).split(sep).join("/")
    for (const m of src.matchAll(/\{/g)) {
      const found = braceBody(src, m.index!)
      if (!found || !found.body.includes("...")) continue
      const entries = topLevelEntries(found.body)
      if (!entries.some((e) => e.kind === "spread" && e.name in fragments)) continue

      const claimed: Record<string, string[]> = {}
      for (const e of entries) {
        if (e.kind === "key") (claimed[e.name] ??= []).push("inline")
        else if (e.name in fragments) {
          for (const k of fragments[e.name]) (claimed[k] ??= []).push(e.name)
        }
      }
      for (const [key, by] of Object.entries(claimed)) {
        if (by.length > 1) {
          out.push({ file: rel, line: src.slice(0, m.index!).split("\n").length, key, claimedBy: by })
        }
      }
    }
  }
  return out
}

describe("select fragments do not overwrite each other", () => {
  it("finds the fragments and the sites that spread them", () => {
    /*
     * The control. Everything below is an absence, and an absence is also what a
     * regex that stopped matching produces — at which point this file reports
     * that a rule holds while checking nothing.
     */
    expect(Object.keys(fragments).length).toBeGreaterThan(3)
    expect(fragments.eventPermissionSelect).toContain("venue")

    const spreadSites = files.filter((f) =>
      /\.\.\.\w*Select/.test(strip(readFileSync(f, "utf8")))
    )
    expect(spreadSites.length).toBeGreaterThan(5)
  })

  it("detects a collision when there is one", () => {
    /*
     * And the counter itself, against known-bad input — because the tree is
     * expected to be clean apart from one allowlisted site, so "found nothing"
     * is the pass condition and a broken detector looks exactly like success.
     */
    const body = "{ ...eventPermissionSelect, ...fenceSelect, id: true }"
    const found = braceBody(body, 0)!
    const entries = topLevelEntries(found.body)
    const claimed: Record<string, string[]> = {}
    for (const e of entries) {
      if (e.kind === "key") (claimed[e.name] ??= []).push("inline")
      else if (e.name in fragments) for (const k of fragments[e.name]) (claimed[k] ??= []).push(e.name)
    }
    // `venue` is claimed by both — the latent collision this guard exists for.
    expect(claimed.venue).toEqual(["eventPermissionSelect", "fenceSelect"])
  })

  it("has no unallowed collision", () => {
    const unallowed = collisions()
      .filter((c) => !(c.file in ALLOWED))
      .map((c) => `${c.file}:${c.line} — "${c.key}" claimed by ${c.claimedBy.join(" and ")}`)

    // The shape carries the hint: jest's `expect` takes one argument, and the
    // message-as-second-argument is a Playwright idiom that throws here.
    expect({
      unallowed,
      hint: unallowed.length
        ? "Two select fragments claiming one key is last-wins, so one resolver silently " +
          "loses a column. Through a relation there is no type error — see CLAUDE.md on a " +
          "select missing `venue` denying a venue owner. Hand-pick the overlap, or order " +
          "the spreads deliberately and say why in the file."
        : "",
    }).toEqual({ unallowed: [], hint: "" })
  })

  it("keeps the allowlist honest by failing on a stale entry", () => {
    /*
     * Without this the allowlist becomes a permanent excuse: somebody removes
     * the overlap, the entry stays, and the next collision in that file is
     * waved through by a note about a problem that no longer exists.
     */
    const colliding = new Set(collisions().map((c) => c.file))
    const stale = Object.keys(ALLOWED).filter((f) => !colliding.has(f))

    expect({ stale }).toEqual({ stale: [] })
  })
})
