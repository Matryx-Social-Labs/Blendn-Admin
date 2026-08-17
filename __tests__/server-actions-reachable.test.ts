import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * Every server action is called by something a user can reach.
 *
 * ## Why this exists
 *
 * This codebase has now produced the same bug six times: a capability is fully
 * built, typechecked, usually unit-tested — and called by nothing.
 * `may_sponsor` with no writer. `canSendSystemMessages` with no caller.
 * `likeAtEvent` with no caller. `stopAllOpsBroadcasts` with no caller. Two
 * sponsor nav items pointing at pages that did not exist. Every one shipped
 * green, because nothing in `tsc`, `jest` or `eslint` asks "can anybody get
 * here".
 *
 * The expensive version of this bug is not the wasted code. It is documentation
 * that becomes false. `lib/venue-claim-actions.ts` argues that its review bar
 * can be relaxed because "auto-link is reversible — an organiser can unlink any
 * event from a venue". That sentence is load-bearing for a security posture, and
 * it is false while `unlinkEventVenue` has no caller.
 *
 * ## Ratchet, not allowlist
 *
 * `KNOWN_UNREACHABLE` is checked in both directions. A new dead action fails,
 * and so does a *stale* entry — wire one up and this test tells you to delete
 * the line. An allowlist that only ever grows is how this class of bug survived
 * six rounds.
 */

const ROOT = join(__dirname, "..")
const PRODUCT_DIRS = ["lib", "app", "components", "hooks"]

/**
 * Built, tested, and reachable by nobody. Each line is a missing screen, not a
 * decision to leave the code dead.
 *
 * `assignVenueOwner`  — no admin control on /dashboard/venue-owners/[id].
 * `updateVenue`       — a venue can be created and never edited.
 * `unlinkEventVenue`  — the reversibility that venue-claim review leans on.
 */
const KNOWN_UNREACHABLE = new Set(["assignVenueOwner", "updateVenue", "unlinkEventVenue"])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      walk(full, out)
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full)
    }
  }
  return out
}

const productFiles = PRODUCT_DIRS.flatMap((d) => walk(join(ROOT, d)))
const sources = new Map(productFiles.map((f) => [f, readFileSync(f, "utf8")]))

/** `"use server"` modules — the ones whose exports are the app's write surface. */
const actionModules = [...sources.entries()].filter(
  ([f, src]) => f.includes(`${"lib"}/`) && src.trimStart().startsWith('"use server"')
)

interface Action {
  module: string
  name: string
}

const actions: Action[] = actionModules.flatMap(([file, src]) =>
  [...src.matchAll(/^export async function (\w+)/gm)].map((m) => ({
    module: file,
    name: m[1],
  }))
)

/** Does any product file other than the declaring one mention this name? */
function callersOf(action: Action): string[] {
  const word = new RegExp(`\\b${action.name}\\b`)
  return [...sources.entries()]
    .filter(([file, src]) => file !== action.module && word.test(src))
    .map(([file]) => file.slice(ROOT.length + 1))
}

describe("server actions are reachable", () => {
  it("found actions to check, so this cannot pass vacuously", () => {
    expect(actionModules.length).toBeGreaterThan(8)
    expect(actions.length).toBeGreaterThan(50)
  })

  it.each(actions.filter((a) => !KNOWN_UNREACHABLE.has(a.name)).map((a) => [a.name, a]))(
    "%s has a caller",
    (_name, action) => {
      expect(callersOf(action as Action)).not.toEqual([])
    }
  )
})

describe("the unreachable list is current", () => {
  it.each([...KNOWN_UNREACHABLE])("%s is still unreachable, or should leave the list", (name) => {
    const action = actions.find((a) => a.name === name)
    // A renamed or deleted action leaves a line here that means nothing.
    expect(action).toBeDefined()
    expect(callersOf(action as Action)).toEqual([])
  })
})

/**
 * A `"use server"` file may only export async functions.
 *
 * `next build` enforces this — "can only export async functions, found object" —
 * and nothing else does. `lib/sponsor-actions.ts` carried a `const` array and a
 * re-exported sync function for several commits while `tsc`, `jest` and `eslint`
 * all passed; the branch simply could not be deployed, and the only way to find
 * out was a 40-second production build.
 *
 * Types are exempt: `export interface` and `export type` are erased before the
 * directive means anything.
 */
describe("use-server modules export only async functions", () => {
  const EXPORT = /^export\s+(?!async function|interface|type\s|\{[^}]*\}\s+from|default\s+async)(.+)$/gm

  it.each(actionModules.map(([f, src]) => [f.slice(ROOT.length + 1), src]))(
    "%s",
    (_label, src) => {
      const offenders = [...(src as string).matchAll(EXPORT)]
        .map((m) => m[0].split("\n")[0].trim())
        // A bare `export { x }` re-export is only safe if x is an async
        // function, which this cannot see — but it is also the shape that broke
        // the build, so it is not exempt.
        .filter((line) => !line.startsWith("export type") && !line.startsWith("export interface"))
      expect(offenders).toEqual([])
    }
  )
})
