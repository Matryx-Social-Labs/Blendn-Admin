import { readFileSync, readdirSync } from "fs"
import { join, sep } from "path"

/**
 * One error contract, both surfaces.
 *
 * Every mobile route already answered through `lib/api-response`. The dashboard
 * routes returned `new NextResponse("Unauthorized", { status: 401 })` — 74
 * times across 12 files. The split ran exactly along the two clients, which is
 * why it survived: each surface was internally consistent, so nothing looked
 * broken from inside either one.
 *
 * ## Why it was a ratchet first
 *
 * Pointing the routes at the envelope was not mechanical, because two consumers
 * read refusals as text:
 *
 *   - `components/event-messaging.tsx`, because `canActivate` returns seven
 *     distinct sentences and flattening them to "Failed to update" names none
 *     of the seven fixes.
 *   - `app/dashboard/reports/builder.tsx`, via `await res.text()`.
 *
 * Migrating routes without those consumers would have rendered
 * `{"success":false,"error":"…"}` verbatim in a toast. So it went
 * consumer-first: `lib/refusal.ts` reads either shape, both consumers moved to
 * it, and only then did the 74 sites change.
 *
 * ## A correction to what this file used to claim
 *
 * It said the raw responses were not a live defect, because `refusal()`
 * "falls back to a generic message when the body is a bare string". It did not.
 * It returned the empty string, the caller did `throw new Error(await
 * refusal(res))`, and the catch did `err.message` — so a 403 on a sponsored
 * message produced an **empty toast**: a notification that appeared and said
 * nothing. The migration fixed that rather than merely tidying it.
 *
 * The budget is gone because the count is zero. What remains is the assertion
 * that it stays zero on both surfaces — a new route copies whichever neighbour
 * its author opened first, and that is how 74 happened.
 */

const ROOT = join(__dirname, "..")

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) routeFiles(full, acc)
    else if (entry.name === "route.ts") acc.push(full)
  }
  return acc
}

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

const rawStringResponses = (src: string) =>
  (strip(src).match(/new NextResponse\(\s*"/g) ?? []).length

const all = routeFiles(join(ROOT, "app", "api"))
const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/")

describe("one error contract, both surfaces", () => {
  it("counts raw responses when they are there", () => {
    /*
     * The control, and it is load-bearing now that the expected answer is zero:
     * every assertion below is satisfied by a detector that has stopped
     * detecting, reported as a rule holding.
     */
    expect(rawStringResponses('return new NextResponse("Unauthorized", { status: 401 })')).toBe(1)
    expect(rawStringResponses("return errorResponse('x', 403)")).toBe(0)
    expect(rawStringResponses("return NextResponse.json({ error: 'x' })")).toBe(0)
    // And that it is reading real files rather than an empty directory.
    expect(all.length).toBeGreaterThan(50)
  })

  it("has no raw-string response in any route, dashboard or mobile", () => {
    const offenders = all
      .map((f) => ({ file: rel(f), n: rawStringResponses(readFileSync(f, "utf8")) }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.file}: ${x.n}`)

    expect({
      offenders,
      hint: offenders.length
        ? "Answer through lib/api-response. A bare string gives the client a second error " +
          "shape to parse, and lib/refusal.ts exists because both shapes were live at once. " +
          "A consumer doing res.json() on a bare string throws; one doing res.text() on an " +
          "envelope shows the user raw JSON."
        : "",
    }).toEqual({ offenders: [], hint: "" })
  })

  it("keeps the consumers reading refusals through the shared reader", () => {
    /*
     * The other half of the pair. Routes on the envelope plus a consumer still
     * calling `res.text()` is the regression this migration existed to avoid,
     * and it is invisible to the offender check above.
     */
    const consumers = ["components/event-messaging.tsx", "app/dashboard/reports/builder.tsx"]
    const offenders = consumers.filter((c) => {
      const src = strip(readFileSync(join(ROOT, c), "utf8"))
      return /await\s+res\.text\(\)/.test(src) || !src.includes("refusalText")
    })

    expect({
      offenders,
      hint: offenders.length
        ? "These read a refusal to show a person. Use refusalText(res, fallback) so an " +
          "envelope does not reach a toast as raw JSON, and a bare string does not reach it " +
          "as an empty message."
        : "",
    }).toEqual({ offenders: [], hint: "" })
  })
})
