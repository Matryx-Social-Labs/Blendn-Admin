import { readFileSync, existsSync } from "fs"
import { join } from "path"

/**
 * The two admin screens curation needs, held to the rules `docs/DESIGN_SYSTEM.md`
 * already settled.
 *
 * The last design review's headline finding was that the plan **re-derived eight
 * decisions fifteen design docs had already made, and got four of them wrong**.
 * So these assert conformance to the doc rather than to a fresh opinion.
 */

const ROOT = join(__dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

const CURATE = "app/dashboard/events/curate/page.tsx"
const CLAIMS = "app/dashboard/claims/page.tsx"

describe("DESIGN_SYSTEM rules the docs already settled", () => {
  it("starts page bodies at h2 — the header owns the only h1", () => {
    /*
     * `components/site-header.tsx` owns it and it holds the page NAME. The
     * header once rendered the name as an eyebrow and the description as the
     * h1, which put the wrong string in the document's only landmark heading.
     */
    for (const rel of [CURATE, CLAIMS, "app/dashboard/claims/venues/page.tsx"]) {
      expect(code(rel)).not.toMatch(/<h1[\s>]/)
    }
    expect(code(CURATE)).toMatch(/<h2/)
  })

  it("uses container queries, never viewport breakpoints", () => {
    /*
     * The sidebar is collapsible, so viewport width and content width differ by
     * a large changing amount. The KPI grid and the spotlight grid once used
     * different systems and visibly fell out of step when it collapsed.
     */
    const src = code(CURATE)
    expect(src).toMatch(/@\w+\/main:/)
    expect(src).not.toMatch(/\b(sm|md|lg|xl|2xl):grid-cols/)
  })

  it("does not put a second HeroMetric on a screen", () => {
    /*
     * Exactly one per screen carries the brand gradient. If a second element
     * wants it, the screen has two priorities and one of them is wrong.
     *
     * Neither screen has one at all, deliberately: the curation screen's most
     * important figure is a FAILURE count, and putting the brand gradient
     * behind "3 dead listings" would be celebrating it.
     */
    for (const rel of [CURATE, CLAIMS]) {
      expect((code(rel).match(/<HeroMetric/g) ?? []).length).toBeLessThanOrEqual(1)
    }
  })

  it("says what will fill an empty screen", () => {
    // "Empty says what will fill it", rather than a bare grid that reads as a
    // broken chart.
    expect(code(CURATE)).toMatch(/<EmptyState/)
    expect(code("app/dashboard/claims/event-claims-table.tsx")).toMatch(/<EmptyState/)
  })

  it("orders the queue oldest-first, because age is the SLA", () => {
    /*
     * The rule the moderation queue states. A claimant waiting on an answer is
     * an organiser deciding whether this platform is worth their time, and
     * newest-first buries exactly the ones who have waited longest.
     */
    expect(code("lib/event-claim-actions.ts")).toMatch(/orderBy: \{ created_at: "asc" \}/)
  })
})

describe("one nav entry, two queues", () => {
  it("moves the venue queue rather than adding a third screen", () => {
    /*
     * The plan's admin table is explicit: three claim queues answering one
     * question should be one screen. Separate tables, one job, one sitting —
     * the same argument `QueueSwitch` makes for flags and reports.
     */
    expect(existsSync(join(ROOT, "app/dashboard/claims/venues/page.tsx"))).toBe(true)
    expect(code("lib/dashboard-nav.ts")).not.toMatch(/title: "Venue claims"/)
    expect(code("lib/dashboard-nav.ts")).toMatch(/url: "\/dashboard\/claims"/)
  })

  it("redirects the old URL rather than deleting it", () => {
    /*
     * That URL is in browser histories and possibly in a bookmark. An admin
     * discovering the queue has vanished is worse than one extra file.
     */
    const moved = code("app/dashboard/venue-claims/page.tsx")
    expect(moved).toMatch(/redirect\("\/dashboard\/claims\/venues"\)/)
  })

  it("counts both queues in the badge", () => {
    /*
     * One entry with a count for half of it leaves somebody waiting with no
     * number anywhere in the chrome — the reason the moderation badge covers
     * flags AND reports.
     */
    const layout = code("app/dashboard/layout.tsx")
    expect(layout).toMatch(/const pendingClaims = eventClaims \+ venueClaims/)
  })

  it("counts the badge in the server layout, not a client effect", () => {
    // An alert that pops in after paint is one the operator has already
    // scrolled past.
    const layout = code("app/dashboard/layout.tsx")
    expect(layout).not.toMatch(/useEffect|"use client"/)
  })
})

describe("the reviewer can act on what they see", () => {
  const src = code("app/dashboard/claims/event-claims-table.tsx")

  it("shows why a row cannot be decided before the buttons, not after", () => {
    /*
     * `decideEventClaim` re-checks and throws, which is correct and a terrible
     * way to learn it. A reviewer working a queue should see that a row cannot
     * be actioned before they read it.
     */
    expect(src).toMatch(/row\.blocked/)
    expect(src).toMatch(/disabled=\{busy \|\| row\.blocked !== null\}/)
  })

  it("renders the flag copy rather than the flag name", () => {
    // A queue full of `source_is_aggregator` teaches nobody anything.
    expect(src).toMatch(/FLAG_COPY\[flag\]/)
  })

  it("marks the flag that invalidates the others", () => {
    // A reviewer who reads "email matches source" and stops has been misled.
    expect(src).toMatch(/flag === "source_is_aggregator"/)
  })

  it("shows the claim number an upsert would have erased", () => {
    expect(src).toMatch(/claim #\{row\.claimNumber\}/)
  })
})

describe("curation health separates a wrong pin from a dead listing", () => {
  const src = code(CURATE)

  it("distinguishes them by whether anybody tried", () => {
    /*
     * The one number is "ended with zero check-ins", and it catches a wrong
     * pin, a wrong time and a dead listing alike — all three produce identical
     * silence. What separates them is the refusals, which is why
     * `check_in_refusals` had to exist first.
     */
    expect(src).toMatch(/row\.checkedIn === 0 && row\.refused > 0/)
    expect(src).toMatch(/row\.checkedIn === 0 && row\.refused === 0/)
  })

  it("counts people on both sides, not attempts", () => {
    const reader = code("app/dashboard/events/curate/queue-actions.ts")
    expect(reader).toMatch(/turnedAway\.get\(e\.id\)\?\.size/)
    expect(reader).toMatch(/attended\.get\(e\.id\)\?\.size/)
  })

  it("is bounded on both queries", () => {
    const reader = code("app/dashboard/events/curate/queue-actions.ts")
    expect(reader).toMatch(/take: 100/)
    expect(reader).toMatch(/take: 5_000/)
  })

  it("gates the read half, not only the page", () => {
    /*
     * The moderation queue had exactly this gap: the page redirected non-admins
     * and the action returning the sensitive data did not. This returns contact
     * emails and free-text notes for every pending claim on the platform.
     */
    expect(code("lib/event-claim-actions.ts")).toMatch(/role !== "app_admin"\) throw new Error\("Not authorised"\)/)
    expect(code("app/dashboard/events/curate/queue-actions.ts")).toMatch(/throw new Error\("Not authorised"\)/)
  })
})

describe("the read surface offers the write", () => {
  const src = code(CURATE)

  it("puts the form on the page, not behind a button", () => {
    /*
     * This screen is reached from a city row on the admin overview saying
     * people are waiting there — so the reason somebody is here is to add one.
     * A screen answering "how is curation going" without offering "add another"
     * is the read surface and the write surface on different pages again, which
     * is exactly how `city_demand` came to be written for months and read never.
     */
    expect(src).toMatch(/<CurateForm defaultCity=\{city\} \/>/)
  })

  it("carries the city through from the demand row", () => {
    // The link is `?city=…` from the overview. Losing it would make somebody
    // retype the one fact the previous screen already knew.
    expect(src).toMatch(/searchParams: Promise<\{ city\?: string \}>/)
  })

  it("asks for no image and no description", () => {
    /*
     * Decision 2. There is no field to fill in wrongly, which is a stronger
     * guarantee than a rule somebody has to remember — the description is
     * generated server-side from the facts entered here.
     */
    const form = code("app/dashboard/events/curate/curate-form.tsx")
    expect(form).not.toMatch(/cover_image|description:/)
  })

  it("reuses the one map, rather than adding a third", () => {
    /*
     * K1.1 found two maps in one section disagreeing about where an event was.
     * A third would be a third answer to "where is this".
     */
    const form = code("app/dashboard/events/curate/curate-form.tsx")
    expect(form).toMatch(/from "@\/components\/location-picker"/)
  })

  it("prefers the geocoder's city over the typed one", () => {
    /*
     * The geocoded name is what the feed filters on. A typed "bangalore"
     * against a geocoded "Bengaluru" makes the event invisible in its own city.
     */
    const form = code("app/dashboard/events/curate/curate-form.tsx")
    expect(form).toMatch(/city: location\.city \?\? form\.city/)
  })

  it("refuses to submit without a pin", () => {
    // `canPublish` would refuse it server-side; saying so before the round trip
    // is the difference between a form and a rejection.
    const form = code("app/dashboard/events/curate/curate-form.tsx")
    expect(form).toMatch(/if \(!location\)/)
  })
})
