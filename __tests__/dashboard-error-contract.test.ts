import { readFileSync, readdirSync } from "fs"
import { join, sep } from "path"

/**
 * Two error contracts in one backend, held finite.
 *
 * Every one of the 64 mobile route files answers through `lib/api-response`.
 * **Zero** of them return a bare string. The dashboard routes return
 * `new NextResponse("Unauthorized", { status: 401 })` — 74 times across 12
 * files. The split is exactly along the two clients, which is why it survived:
 * each surface is internally consistent, so nothing is visibly broken.
 *
 * ## Why this is a ratchet and not a migration
 *
 * The obvious fix is to point the dashboard at `lib/api-response` too. It is
 * not mechanical, and the reason is on the client side:
 *
 *   - `components/event-messaging.tsx` reads refusals **verbatim** and shows
 *     them in a toast, because `canActivate` returns seven distinct sentences
 *     and its comment records that flattening them to "Failed to update" named
 *     none of the seven fixes.
 *   - `app/dashboard/reports/builder.tsx` does `await res.text()` directly.
 *
 * Change the routes without the consumers and a user sees `{"success":false}`
 * where a sentence used to be — a regression in the exact place the current
 * shape was chosen to protect. So the migration is route-and-consumer in
 * pairs, verified in a browser, and it is a piece of work rather than a sweep.
 *
 * Meanwhile the count must not grow. A new dashboard route written today
 * copies whichever neighbour its author opened first, and that is how 74
 * happened.
 *
 * ## What is NOT claimed
 *
 * That this is a live defect. It is not. `refusal()` in `event-messaging.tsx`
 * parses JSON and falls back to a generic message when the body is a bare
 * string, so the raw responses degrade to "Failed to update" rather than
 * rendering as JSON. The cost is a developer one — two contracts to know about
 * — plus the seven-sentences case being one careless edit from regressing.
 */

const ROOT = join(__dirname, "..")

/**
 * Raw-string responses per dashboard route file, measured 2026-08-28.
 *
 * **May shrink. Must never grow.** A file reaching zero comes out of the list;
 * the staleness check below is what makes that mandatory rather than optional.
 */
const BUDGET: Record<string, number> = {
  "app/api/events/[id]/announcements/route.ts": 9,
  "app/api/events/[id]/chat/members/[userId]/route.ts": 6,
  "app/api/events/[id]/chat/messages/[messageId]/route.ts": 6,
  "app/api/events/[id]/chat/messages/route.ts": 4,
  "app/api/events/[id]/route.ts": 14,
  "app/api/events/[id]/sponsored-messages/[msgId]/route.ts": 10,
  "app/api/events/[id]/sponsored-messages/route.ts": 9,
  "app/api/events/route.ts": 9,
  "app/api/geocode/route.ts": 1,
  "app/api/organisation/join-request/route.ts": 2,
  "app/api/reports/[key]/route.ts": 3,
  "app/api/search/route.ts": 1,
}

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) routeFiles(full, acc)
    else if (entry.name === "route.ts") acc.push(full)
  }
  return acc
}

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

const rawStringResponses = (src: string) =>
  (strip(src).match(/new NextResponse\(\s*"/g) ?? []).length

const all = routeFiles(join(ROOT, "app", "api"))
const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/")
const dashboard = all.filter((f) => !rel(f).includes("/mobile/"))
const mobile = all.filter((f) => rel(f).includes("/mobile/"))

const measured: Record<string, number> = {}
for (const f of dashboard) {
  const n = rawStringResponses(readFileSync(f, "utf8"))
  if (n > 0) measured[rel(f)] = n
}

describe("the dashboard error contract only converges", () => {
  it("counts raw responses when they are there", () => {
    /*
     * The control. Every assertion below is satisfied by a counter that has
     * stopped counting — a budget nothing exceeds and no entry that looks
     * stale, reported as a rule holding.
     */
    expect(rawStringResponses('return new NextResponse("Unauthorized", { status: 401 })')).toBe(1)
    expect(rawStringResponses("return NextResponse.json({ error: 'x' })")).toBe(0)
    expect(Object.keys(measured).length).toBeGreaterThan(5)
  })

  it("keeps every mobile route on the shared envelope", () => {
    /*
     * The half that is already won, asserted so it stays won. `lib/api-response`
     * covers 64 of 64 mobile route files, and the cheapest way to lose that is
     * one new route copying a dashboard neighbour.
     */
    const offenders = mobile
      .filter((f) => rawStringResponses(readFileSync(f, "utf8")) > 0)
      .map(rel)

    expect({
      offenders,
      hint: offenders.length
        ? "Mobile routes answer through lib/api-response. A bare string here gives the Expo " +
          "client a second error shape to parse."
        : "",
    }).toEqual({ offenders: [], hint: "" })
  })

  it("has no dashboard file above its budget, and no new file", () => {
    const regressions: string[] = []
    for (const [file, n] of Object.entries(measured)) {
      const allowed = BUDGET[file]
      if (allowed === undefined) regressions.push(`${file}: NEW, ${n} raw responses`)
      else if (n > allowed) regressions.push(`${file}: ${n} raw responses, budget ${allowed}`)
    }

    // The shape carries the hint: jest's `expect` takes one argument, and the
    // message-as-second-argument is a Playwright idiom that throws here.
    expect({
      regressions,
      hint: regressions.length
        ? "Dashboard routes are migrating to lib/api-response, and the count may only fall. " +
          "Migrate the route and its consumer together — two clients read these bodies as " +
          "text and would show raw JSON in a toast."
        : "",
    }).toEqual({ regressions: [], hint: "" })
  })

  it("fails on a stale entry, so the budget cannot become an allowlist", () => {
    const stale = Object.entries(BUDGET)
      .filter(([file, n]) => (measured[file] ?? 0) < n)
      .map(([file, n]) => `${file}: budget ${n}, actually ${measured[file] ?? 0} — lower it`)

    expect({ stale }).toEqual({ stale: [] })
  })
})
