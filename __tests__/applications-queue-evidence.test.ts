import { readFileSync } from "fs"
import { join } from "path"

import { isAggregatorDomain } from "@/lib/curation-sources"

const ROOT = join(__dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

/**
 * The applications queue ranks its evidence, and its two extremes do not look
 * the same.
 *
 * A filled brand badge reads as positive. The queue rendered
 * `thehummingtree.com` — the applicant's own domain, the strongest credential
 * the gate can produce — and `in.bookmyshow.com` — a ticketing aggregator, the
 * strongest disqualifier — in the **same** filled badge, while "Personal email"
 * got a different one. The two extremes looked identical and the middle looked
 * different.
 *
 * The stake is stated in the curated-events design: without the aggregator
 * check, one address at a ticketing platform could claim every event on the
 * platform. A company address is accepted as-is precisely because it is
 * evidence the applicant belongs to the organisation — and that argument
 * inverts at an aggregator, where the events being claimed are not theirs.
 */
describe("isAggregatorDomain", () => {
  it("matches a bare host and its parents, like its URL sibling", () => {
    expect(isAggregatorDomain("in.bookmyshow.com")).toBe(true)
    expect(isAggregatorDomain("bookmyshow.com")).toBe(true)
    // Subdomains, because listing every one of them is not maintainable.
    expect(isAggregatorDomain("events.eventbrite.co.uk")).toBe(true)
  })

  it("does not flag a venue's own domain", () => {
    // The case this must never catch: a real venue applying with its own
    // address is the strongest positive signal in the queue.
    expect(isAggregatorDomain("thehummingtree.com")).toBe(false)
    expect(isAggregatorDomain("toit.in")).toBe(false)
  })

  it("is not tripped by case or a www prefix", () => {
    expect(isAggregatorDomain("WWW.BookMyShow.com")).toBe(true)
  })

  it("says no to nothing rather than throwing", () => {
    expect(isAggregatorDomain(null)).toBe(false)
    expect(isAggregatorDomain(undefined)).toBe(false)
    expect(isAggregatorDomain("")).toBe(false)
  })
})

describe("the queue renders the ranking", () => {
  it("draws an aggregator domain as a warning, not as a credential", () => {
    const src = read("app/dashboard/onboarding/queue.tsx")
    expect(src).toMatch(/row\.aggregatorDomain \? \(/)
    expect(src).toMatch(/variant="destructive"[\s\S]{0,200}Ticketing platform/)
  })

  it("carries the age on the collapsed row, from the shared rule", () => {
    /*
     * `Applied` was a bare date inside a panel you had to open, on the one
     * screen where age IS the ordering — so the overview could say "oldest 12
     * days" and this screen could not say which row that was.
     *
     * The same functions the attention strip uses, so the two cannot disagree
     * about what late means.
     */
    const src = read("app/dashboard/onboarding/queue.tsx")
    expect(src).toMatch(/queueAgeLabel|queueBreached/)
    expect(src).toMatch(/from "@\/lib\/attention-queues"/)
    // And not a second, local age calculation.
    expect(src).not.toMatch(/Date\.now\(\) - .*created_at/)
  })

  it("takes server time rather than reading the clock during hydration", () => {
    // An application at 71h59m crosses the SLA boundary between the server
    // render and hydration, and React reports a mismatch on a screen that was
    // correct both times. Same fix as the overview's `generatedAt`.
    expect(read("app/dashboard/onboarding/queue.tsx")).toMatch(/generatedAt: string/)
    expect(read("app/dashboard/onboarding/page.tsx")).toMatch(/generatedAt=\{new Date\(\)\.toISOString\(\)\}/)
  })

  it("does not make the near-irreversible action the loudest thing on the row", () => {
    /*
     * Approve creates an organisation, a user and a membership in one
     * transaction and hands over publishing and the attendee list. It was the
     * filled brand button on all seven rows — the same inversion as the events
     * list, where `published` was a filled pill on fifteen of seventeen.
     */
    const src = read("app/dashboard/onboarding/queue.tsx")
    expect(src).toMatch(/variant="outline" onClick=\{approve\}/)
    expect(src).toMatch(/Approve &amp; create the account/)
  })
})
