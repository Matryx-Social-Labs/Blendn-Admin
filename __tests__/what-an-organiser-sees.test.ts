import { readFileSync } from "fs"
import { join } from "path"
import { discloseFigure, mayQuote, MIN_CELL } from "@/lib/disclosure"

/**
 * What a host may learn about the people in their room.
 *
 * ## A correction to the register, first
 *
 * The audit cites `lib/disclosure.ts` in six places — as "a correct four-part
 * suppression rule" with "one caller", to be extended to four more. **There was
 * no such file**, no `discloseFigure`, and no poll suppression. The only
 * small-number rule in the codebase was `MIN_ATTENDEES = 8`, hand-rolled in
 * `lib/connection-metrics.ts`.
 *
 * So every finding phrased as "the rule exists and is not applied here" was
 * really "there is no rule", and W19 was costed as wiring when it is building.
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

describe("the four parts", () => {
  const ok = { count: 10, contributors: 10, population: 100 }

  it("publishes a figure that passes all four", () => {
    expect(discloseFigure(ok)).toEqual({ value: 10, suppressed: false, reason: null })
  })

  it("suppresses a cell smaller than the floor", () => {
    // "1 safety_conduct message" in a room of six is a sentence with an author.
    const d = discloseFigure({ ...ok, count: 1, contributors: 1, population: 6 })
    expect(d.suppressed).toBe(true)
    expect(d.reason).toBe("min_cell")
    expect(d.value).toBeNull()
  })

  it("suppresses a cell one contributor dominates", () => {
    /*
     * Forty complaints in a room of two hundred looks safe until thirty-eight
     * came from one person — the organiser can then see who was upset, and the
     * cell size protected nobody.
     */
    const d = discloseFigure({ ...ok, topContributorShare: 0.95 })
    expect(d.suppressed).toBe(true)
    expect(d.reason).toBe("dominance")
  })

  it("suppresses a cell that covers everybody", () => {
    // "All 6 attendees reported a safety concern" names six people.
    const d = discloseFigure({ count: 6, contributors: 6, population: 6 })
    expect(d.suppressed).toBe(true)
    expect(d.reason).toBe("completeness")
  })

  it("suppresses a cell one short of everybody", () => {
    // The same fact inverted: it identifies the one person who is not in it.
    const d = discloseFigure({ count: 9, contributors: 9, population: 10 })
    expect(d.suppressed).toBe(true)
    expect(d.reason).toBe("residual")
  })

  it("reports the strongest objection, not the first to run", () => {
    /*
     * A cell covering the whole population identifies everybody in it however
     * evenly they contributed, so dominance is the weaker complaint and should
     * not be the one named.
     */
    const d = discloseFigure({
      count: 8,
      contributors: 8,
      population: 8,
      topContributorShare: 0.9,
    })
    expect(d.reason).toBe("completeness")
  })

  it("takes a declared floor rather than a second rule", () => {
    /*
     * ER5. `connection-metrics` keeps 8, because its figure is about pairs and
     * a pair is more identifying than an individual — but as a parameter, not
     * as a hand-rolled comparison in its own file.
     */
    expect(discloseFigure({ count: 6, contributors: 6, population: 50 }).suppressed).toBe(false)
    expect(
      discloseFigure({ count: 6, contributors: 6, population: 50, floor: 8 }).suppressed
    ).toBe(true)
    expect(MIN_CELL).toBe(5)
  })
})

describe("W41 — the feedback digest stops naming whoever raised a concern", () => {
  it("refuses to quote from a category too few people raised", () => {
    expect(mayQuote({ contributors: 1, population: 6 })).toBe(false)
    expect(mayQuote({ contributors: 8, population: 60 })).toBe(true)
  })

  it("counts distinct people per category, not messages", () => {
    /*
     * One upset attendee posting six complaints is one person. Counting
     * messages would let them unlock their own quotes.
     */
    const src = code("app/dashboard/events/[id]/feedback/actions.ts")
    expect(src).toMatch(/categoryContributors = new Map<string, Set<string>>/)
    expect(src).toMatch(/people\.add\(row\.message\.user_id\)/)
  })

  it("derives `quotable` from the rule, not from a constant", () => {
    /*
     * The assertions below check the *consumer* — `at: quotable ? … : null` —
     * and a first draft of them passed against `const quotable = true`. A guard
     * that pins the shape of a conditional without pinning where its condition
     * comes from is not a guard.
     *
     * Third time this session a control caught a structural test asserting the
     * consumer and not the producer.
     */
    const src = code("app/dashboard/events/[id]/feedback/actions.ts")
    expect(src).toMatch(
      /const quotable = mayQuote\(\{\s*contributors: categoryContributors\.get\(row\.category\)\?\.size \?\? 0,\s*population,\s*\}\)/
    )
  })

  it("drops the timestamp with the text", () => {
    /*
     * "22:14" plus a room-stable pseudonym is the same identification by
     * another route, so suppressing the text alone would have left the hole
     * open.
     */
    const src = code("app/dashboard/events/[id]/feedback/actions.ts")
    expect(src).toMatch(/at: quotable \? row\.message\.created_at\.toISOString\(\) : null/)
    expect(src).toMatch(/text: quotable \? row\.message\.content : null/)
    expect(src).toMatch(/pseudonym: quotable \?/)
  })

  it("suppresses the category count without hiding the category", () => {
    // An organiser still needs to know a safety concern was raised.
    const src = code("app/dashboard/events/[id]/feedback/actions.ts")
    expect(src).toMatch(/count: disclosure\.value/)
    expect(src).toMatch(/suppressed: disclosure\.suppressed/)
  })
})

describe("W18 — the organiser roster", () => {
  const src = code("app/dashboard/attendees/page.tsx")

  it("never serves an email address", () => {
    /*
     * `name ?? email` meant an attendee who had not set a name handed the
     * organiser a way to contact them off platform — where there is no block,
     * no report and no record. Decision 7 is explicit.
     */
    expect(src).not.toMatch(/\.email/)
    expect(src).not.toMatch(/email: true/)
  })

  it("never serves the raw user id", () => {
    /*
     * The row carried `user_id` into the client payload — the same id the chat
     * participants list hands out, which is what turns a pseudonymous room back
     * into named people.
     */
    expect(src).toMatch(/const label = attendeeLabel\(userId, labelScope\)/)
    expect(src).toMatch(/id: label,/)
    expect(src).not.toMatch(/id: userId,/)
  })

  it("scopes on the organisation, not on who created the row", () => {
    /*
     * `{ organizer_id: session.user.id }` meant a colleague at the same
     * organisation saw an empty roster and somebody who had left kept theirs.
     * `authz-scoping-boundary.test.ts` missed it because it scans for a
     * hand-rolled `organizer_id !==` comparison and this was a `where` clause.
     */
    expect(src).toMatch(/await eventScopeFor\(session\.user\.role, session\.user\.id\)/)
    expect(src).not.toMatch(/organizer_id: session\.user\.id/)
  })

  it("counts events, not check-in rows", () => {
    /*
     * One row per person per day, so a three-day conference counted as three
     * attendances — and `repeat` is `attended > 1`, so one attendee at one
     * multi-day event was a returning attendee on the screen whose whole
     * purpose is telling an organiser whether they are building an audience.
     *
     * The counting sweep missed this screen because it never used `_count`: it
     * incremented in a loop, which the boundary test cannot see.
     */
    expect(src).toMatch(/events: Set<string>/)
    expect(src).toMatch(/attended\?\.events\.size \?\? 0/)
  })
})

describe("one suppression rule, not three", () => {
  it("routes connection metrics through the module", () => {
    const src = code("lib/connection-metrics.ts")
    expect(src).toMatch(/discloseFigure\(\{/)
    expect(src).toMatch(/floor: MIN_ATTENDEES/)
  })
})
