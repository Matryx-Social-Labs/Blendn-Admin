import { readFileSync } from "fs"
import { join } from "path"
import { LAUNCH_READY } from "@/lib/demand"

/**
 * Which city to open next.
 *
 * `city_demand` has been written on every miss since it was added — and read by
 * nothing. Its own index comment calls the missing query *"the only query this
 * table exists for"*. This is that query, plus the reason the screen could not
 * have rendered it even if somebody had written it.
 */

const ROOT = join(__dirname, "..")
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

describe("C12 — the list could not show the signal it collects", () => {
  it("unions cities with demand into the row set, not just cities with events", () => {
    /*
     * The Cities table was built by iterating events and folding by city, so a
     * city with demand and ZERO events could not appear in it at all — which is
     * exactly the city the number exists for: somewhere people are looking and
     * nobody is supplying.
     */
    const src = code("app/dashboard/actions.ts")
    expect(src).toMatch(/for \(const row of await cityDemand\(50\)\)/)
    // And a demand-only city creates a row rather than being skipped.
    expect(src).toMatch(/cityMap\.set\(row\.cityKey, \{/)
  })

  it("keys cities the way the rest of the codebase keys them", () => {
    /*
     * The fold was on the raw `city` string, so "Bengaluru" and "bengaluru"
     * were two rows in the table a founder reads to decide where to launch.
     * `cityKey` is what `city_demand` stores and what the events cache
     * normalises on — anything else guarantees the two sides never line up.
     */
    const src = code("app/dashboard/actions.ts")
    expect(src).toMatch(/const key = cityKey\(city\)/)
    expect(src).toMatch(/cityMap\.set\(key, existing\)/)
  })
})

describe("the decision rule, not just the number", () => {
  it("requires people waiting AND nobody serving them", () => {
    /*
     * A city with twenty-five waiting and forty events is not a launch
     * opportunity, it is a discovery problem — and telling a founder to "open"
     * it sends them to do work that is already done.
     */
    const src = code("lib/demand.ts")
    expect(src).toMatch(/row\.waiting >= LAUNCH_READY && row\.events === 0/)
  })

  it("thresholds on a room's worth of people, not a market's", () => {
    /*
     * The product's unit is a room on a night, so the threshold is a room's
     * worth. Enough that a first event is not six people in a large bar, which
     * is the failure mode that kills a launch city before it starts.
     */
    expect(LAUNCH_READY).toBeGreaterThanOrEqual(20)
    expect(LAUNCH_READY).toBeLessThan(100)
  })

  it("is a constant, so the first real launch can move it in one place", () => {
    const src = code("lib/demand.ts")
    expect(src).toMatch(/export const LAUNCH_READY/)
    expect(src).not.toMatch(/waiting >= 25/)
  })
})

describe("counting people is guaranteed, not assumed", () => {
  it("relies on the unique constraint rather than on remembering", () => {
    /*
     * `city_demand` is `@@unique([user_id, city_key])`, so one row IS one
     * person. Worth stating in a codebase where nine other call sites counted
     * rows and said people.
     */
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")
    const model = /model city_demand \{[\s\S]*?\n\}/.exec(schema)!
    expect(model[0]).toMatch(/@@unique\(\[user_id, city_key\]\)/)
    expect(code("lib/demand.ts")).toMatch(/_count: \{ user_id: true \}/)
  })

  it("is bounded", () => {
    expect(code("lib/demand.ts")).toMatch(/take: limit/)
  })
})

describe("the read surface opens the write surface", () => {
  it("links a city row into the curation queue for that city", () => {
    /*
     * Structural, not tidy. The way a signal ends up with no reader is that
     * seeing it and acting on it live on different screens — which is how
     * `city_demand` was written for months and read never.
     */
    const src = readFileSync(join(ROOT, "components/dashboard/overview-admin.tsx"), "utf8")
    expect(src).toMatch(/\/dashboard\/events\/curate\?city=\$\{encodeURIComponent\(row\.city\)\}/)
  })

  it("renders the decision beside the number", () => {
    // A metric with no decision rule is a metric nobody acts on.
    const src = readFileSync(join(ROOT, "components/dashboard/overview-admin.tsx"), "utf8")
    expect(src).toMatch(/row\.launchReady/)
    expect(src).toMatch(/ready/)
  })
})
