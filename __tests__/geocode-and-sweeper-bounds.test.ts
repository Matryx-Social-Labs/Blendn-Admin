import { readFileSync } from "fs"
import { join } from "path"
import { geocodeBudget, MAX_GEOCODES_PER_REQUEST } from "@/lib/location"

/**
 * Two unbounded fan-outs, on the two paths that run most often.
 *
 * Both are the same mistake at different scales: a per-item operation inside a
 * loop over an unbounded collection, on a path nobody thought of as a loop.
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

describe("the discovery feed cannot fan out geocodes", () => {
  it("spends at most the budget", () => {
    const budget = geocodeBudget()
    const taken = Array.from({ length: 50 }, () => budget.take()).filter(Boolean)
    expect(taken).toHaveLength(MAX_GEOCODES_PER_REQUEST)
    expect(budget.exhausted).toBe(true)
  })

  it("gives each request its own budget", () => {
    /*
     * Made per request, not module-level. A shared counter would let one busy
     * page exhaust the budget for everybody else's — which is a worse failure
     * than the one being fixed, because it is intermittent.
     */
    const a = geocodeBudget()
    const b = geocodeBudget()
    while (a.take()) { /* drain a */ }
    expect(a.exhausted).toBe(true)
    expect(b.take()).toBe(true)
  })

  it("resolves the city at write time so the read path has one to serve", () => {
    /*
     * `resolveEventCity` was called per event on the feed and reverse-geocodes
     * through Nominatim when `city` is null — so a page of twenty null-city rows
     * fanned out twenty concurrent requests to a public API, on a user-facing
     * path, bypassing the `/api/geocode` proxy built to stop exactly that.
     *
     * It was never a read-path question: an event's city is a fact about the
     * event, decided when it is created.
     */
    expect(code("app/api/events/route.ts")).toMatch(
      /const resolvedCity = await resolveEventCity\(city, latitude, longitude\)/
    )
    // And re-resolved when the pin moves, or an event that moved across town
    // keeps the wrong label on the field the feed filters by.
    expect(code("app/api/events/[id]/route.ts")).toMatch(/const movedPin =/)
  })

  it("budgets both doors into the geocoder", () => {
    /*
     * `resolveEventCity` consults `normalizeLocationToCity` before its own
     * coordinate branch, and that geocodes too when `city` is literally
     * "12.97,77.59". The budget missed it at first — a cap on one of two
     * entrances is not a cap.
     */
    const src = code("lib/location.ts")
    expect((src.match(/if \(budget && !budget\.take\(\)\) return null/g) ?? []).length).toBe(2)
    /*
     * A cached coordinate costs nothing, so it must not spend budget — else a
     * page of twenty events at one venue would stop after three. The check has
     * to come immediately before the spend at both doors, not merely exist
     * somewhere in the file.
     */
    const SPEND = "if (budget && !budget.take()) return null"
    const beforeEachSpend = src.split(SPEND).slice(0, -1)
    expect(beforeEachSpend).toHaveLength(2)
    for (const preceding of beforeEachSpend) {
      expect(preceding.slice(-200)).toContain("coordinateCache.has(cacheKey)")
    }
  })
})

describe("the presence sweeper is bounded, by room", () => {
  const src = code("lib/presence-sweeper.ts")

  it("takes a bounded set of events rather than every open check-in", () => {
    /*
     * The query was `findMany({ where: { status: "checked_in" } })` — every open
     * check-in on the platform, no `take`, no scope, each row dragging the
     * event's geofence JSON and the venue's, every five minutes, on the
     * Socket.io event loop.
     */
    expect(src).toMatch(/MAX_EVENTS_PER_SWEEP = 200/)
    expect(src).toMatch(/groupBy\(\{\s*by: \["event_id"\]/)
    expect(src).toMatch(/take: MAX_EVENTS_PER_SWEEP/)
    expect(src).toMatch(/event_id: \{ in: busiest\.map/)
  })

  it("bounds events and not rows, because the guard needs a whole room", () => {
    /*
     * The mass-checkout guard reasons about the share of a room that is
     * leaving. A half-fetched event would compute that share against a partial
     * denominator and either trip on nothing or fail to trip on everything.
     */
    expect(src).not.toMatch(/findMany\(\{[\s\S]{0,200}status: "checked_in",[\s\S]{0,200}take:/)
  })

  it("drains oldest first, so no room is starved", () => {
    expect(src).toMatch(/orderBy: \{ _min: \{ created_at: "asc" \} \}/)
  })

  it("says so when the cap is reached", () => {
    // Not an error — the next pass continues. But a permanently full batch
    // means somebody is staying checked in longer than they should.
    expect(src).toMatch(/Presence sweep hit its event cap/)
  })
})
