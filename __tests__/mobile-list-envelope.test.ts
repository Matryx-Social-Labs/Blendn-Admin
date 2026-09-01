import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative, sep } from "path"

/**
 * A mobile list is always `data.<name>`, never a bare array.
 *
 * ## Why a rule rather than a convention
 *
 * Recording the whole read surface for the first time (E13,
 * `e2e/__contracts__/mobile-api.json`) showed eleven list endpoints answering
 * `data.events`, `data.venues`, `data.notifications` — and two answering `data`
 * directly: `/categories` and `/conversations`.
 *
 * Two exceptions is the worst number. One is a special case somebody remembers;
 * zero is a rule; two is a rule the next person breaks without noticing,
 * because the file they copied from happened to be one of the eleven.
 *
 * It also closed off growth. Every wrapped list carries a `pagination` sibling.
 * A bare array has nowhere to put a cursor, so `/conversations` — the surface
 * most likely to need paging — could not have gained one without a breaking
 * change to a shipped client.
 *
 * ## What this catches
 *
 * `successResponse(someArrayVariable)`: a response whose `data` is a bare
 * collection. It cannot catch every shape and does not try. It catches the one
 * that was actually wrong twice — a plural identifier handed straight to
 * `successResponse`.
 */

const ROOT = join(__dirname, "..")
const MOBILE = join(ROOT, "app", "api", "mobile")

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) routeFiles(full, acc)
    else if (entry === "route.ts") acc.push(full)
  }
  return acc
}

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

/**
 * Which identifiers name a collection.
 *
 * The first version listed the singular names to skip — `updated`, `outcome`,
 * `profile` — and immediately missed `messageData` and `publicProfile`. A
 * deny-list of singular nouns has no end: every new route can invent one.
 *
 * So the test asks the opposite question. A collection is named plurally, and
 * that is a property of the word rather than a list somebody maintains.
 * `status` and `count` are the ordinary English exceptions.
 */
const NOT_PLURAL = new Set(["status", "count", "progress", "address", "success"])
const namesACollection = (id: string) => {
  if (NOT_PLURAL.has(id.toLowerCase())) return false
  return /(s|List|Items|Rows)$/.test(id)
}

describe("every mobile list response is named", () => {
  const files = routeFiles(MOBILE)

  it("finds the routes at all", () => {
    // Guards the walker: a broken walk makes the assertion below vacuous, which
    // is exactly the failure R16's controls exist to catch.
    expect(files.length).toBeGreaterThan(50)
  })

  it("hands successResponse an object, not a bare collection", () => {
    const offenders: string[] = []

    for (const file of files) {
      const src = strip(readFileSync(file, "utf8"))
      for (const match of src.matchAll(/successResponse\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        const name = match[1]
        if (!namesACollection(name)) continue
        offenders.push(`${relative(ROOT, file).split(sep).join("/")} :: successResponse(${name})`)
      }
    }

    // The shape carries the hint, because jest's `expect` takes one argument —
    // the second-argument message is a Playwright idiom, and it throws here.
    // Same pattern as `__tests__/server-actions-reachable.test.ts`.
    expect({
      offenders,
      hint:
        offenders.length > 0
          ? "Wrap it: successResponse({ things }). Every other list endpoint already does, and a " +
            "bare array has nowhere to grow a pagination cursor."
          : "",
    }).toEqual({ offenders: [], hint: "" })
  })
})
