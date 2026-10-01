// Relative: the live tick reaches this from server.ts, which `build:server`
// compiles with plain tsc (see __tests__/server-import-boundary.test.ts).
import { SPONSORSHIP } from "./constants"

/**
 * When an aggregate stops being an aggregate.
 *
 * ## This module did not exist
 *
 * The audit register cites `lib/disclosure.ts` in six places — as "a correct
 * four-part suppression rule" with "one caller", to be extended to four more.
 * There was no such file, and no `discloseFigure`, and no poll suppression.
 * The only small-number rule in the codebase was `MIN_ATTENDEES = 8`,
 * hand-rolled in `lib/connection-metrics.ts`. So W19 was costed as wiring and is
 * actually building.
 *
 * That matters beyond bookkeeping: every finding that said "the rule exists and
 * is not applied here" was really "there is no rule".
 *
 * ## The four parts
 *
 * A count is safe to publish when all four hold. They are the standard
 * statistical-disclosure checks, and each one exists because the others do not
 * catch its case.
 *
 * 1. **Minimum cell.** Fewer than `floor` contributors and the figure is about
 *    named individuals. "One safety_conduct message" in a room of six is a
 *    sentence with an author.
 *
 * 2. **Dominance.** One contributor responsible for most of a cell is
 *    identifying even when the cell is large. Forty complaints in a room of
 *    two hundred looks safe until thirty-eight came from one person, and the
 *    organiser can see who was upset.
 *
 * 3. **Completeness.** A cell equal to the population identifies *everyone* in
 *    it. "All 6 attendees reported a safety concern" names six people as surely
 *    as listing them.
 *
 * 4. **Residual.** A cell one short of the population is the same fact
 *    inverted — it identifies the one person who is not in it.
 *
 * ## Why a floor of 5, and why 8 stays
 *
 * Five is the conventional minimum cell and it is what the register names.
 * `connection-metrics` keeps 8, because its figure is about *pairs* and pairs
 * are more identifying than individuals — at eight attendees "3 connections" is
 * 28 possible pairs. Per ER5 that is a **declared parameter**, passed in, not a
 * second rule living somewhere else.
 *
 * ## What this does not do
 *
 * It does not decide what to show instead. A suppressed count is `null` and the
 * caller writes the copy, because "fewer than 5" reads differently on a
 * dashboard tile and in a post-event digest.
 */

/** The conventional minimum cell. Override only with a reason. */
export const MIN_CELL = 5

/**
 * The share of a cell one contributor may hold before the cell identifies them.
 *
 * 0.5 rather than something stricter: a contributor holding exactly half of a
 * five-person cell is two of four others, which is not yet a name. Above half
 * they are the majority of the thing being reported.
 */
export const MAX_DOMINANCE = 0.5

export interface DiscloseInput {
  /** The figure being published. */
  count: number
  /** How many distinct people contributed to it. */
  contributors: number
  /** How many people could have. The denominator the cell sits in. */
  population: number
  /** The largest share held by any single contributor, if known. */
  topContributorShare?: number
  /** Defaults to `MIN_CELL`. Declare a different one, do not hand-roll. */
  floor?: number
}

export type SuppressionReason =
  | "min_cell"
  | "dominance"
  | "completeness"
  | "residual"

export interface Disclosure {
  /** The figure, or null when it must not be published. */
  value: number | null
  suppressed: boolean
  /** Why, so a caller can explain it and a test can assert which rule fired. */
  reason: SuppressionReason | null
}

/**
 * May this figure be shown?
 *
 * Checks in order of how obviously they identify somebody, so `reason` names
 * the strongest objection rather than whichever ran first.
 */
export function discloseFigure(input: DiscloseInput): Disclosure {
  const floor = input.floor ?? MIN_CELL

  const suppress = (reason: SuppressionReason): Disclosure => ({
    value: null,
    suppressed: true,
    reason,
  })

  // 1. Minimum cell.
  if (input.contributors < floor) return suppress("min_cell")

  /*
   * 3 and 4 before 2: a cell that covers the whole population identifies
   * everybody in it regardless of how evenly they contributed, so dominance is
   * the weaker objection and should not be the one reported.
   *
   * Both need a population to reason about. `population === 0` means nobody
   * could have contributed, so there is nothing to identify.
   */
  if (input.population > 0) {
    if (input.contributors >= input.population) return suppress("completeness")
    if (input.contributors === input.population - 1) return suppress("residual")
  }

  // 2. Dominance.
  if (
    input.topContributorShare !== undefined &&
    input.topContributorShare > MAX_DOMINANCE
  ) {
    return suppress("dominance")
  }

  return { value: input.count, suppressed: false, reason: null }
}

/**
 * Guests at one event, or one day of it, as a venue sees them (SCRUM-501):
 * the minimum cell, and nothing else.
 *
 * Not the completeness and residual rules against the going RSVPs. Those
 * identify somebody only to a reader who knows who RSVP'd, and the venue does
 * not — "everyone who said yes came" names nobody it can see. Applied anyway,
 * they held back every night walk-ins outnumbered RSVPs, which is the venue's
 * busiest kind (orchestrator's decision, 2026-10-01; the owner may reverse it).
 * An organiser reading their own event is a different reader and keeps exact
 * counts.
 */
export function discloseGuests(guests: number): number | null {
  return discloseFigure({ count: guests, contributors: guests, population: 0 }).value
}

/**
 * One event's counts for a host who reached it through the building rather
 * than by running it: a venue owner at another host's event (SCRUM-501).
 *
 * The same rule wherever those counts appear — the Events list, the venue
 * page, the Events export — so no surface prints what another blanks. Fill is
 * Going over capacity, so it goes when Going does.
 *
 * `arriving` (`stillArriving`): who came is held back altogether while people
 * can still be coming in. Reloading a list or re-downloading an export is
 * watching the number, and it moves by one with each arrival; the Live tab
 * gives the venue the night as ranges instead (SCRUM-516).
 */
export function discloseVenueCounts(c: {
  going: number
  attended: number
  capacity: number | null
  arriving?: boolean
}): { going: number | null; attended: number | null; fillPct: number | null } {
  const going = discloseFigure({ count: c.going, contributors: c.going, population: 0 }).value
  return {
    going,
    attended: c.arriving ? null : discloseGuests(c.attended),
    fillPct: going !== null && c.capacity ? Math.round((going / c.capacity) * 100) : null,
  }
}

/**
 * Any other count of people a venue is shown -- maybe, saved, inside now,
 * turned away -- or null under the floor. Who came and who is going go through
 * `discloseVenueCounts`, the rule every venue surface shares.
 *
 * Zero is shown: it identifies nobody, and "held back" over an empty room
 * would read as a secret where there is none.
 */
export function discloseHeadcount(count: number): number | null {
  if (count === 0) return 0
  return discloseFigure({ count, contributors: count, population: 0 }).value
}

/** A live count as a venue is told it: a range, never the number. In order. */
export const LIVE_RANGES = ["0", "a few", "5–9", "10–19", "20+"] as const
export type LiveRange = (typeof LIVE_RANGES)[number]

/**
 * A count of people that is still moving -- in the room, arrived, left, in
 * the last ten minutes -- for a venue watching another host's night or its own
 * venue day (SCRUM-516, D-19).
 *
 * The floor alone is not enough for a figure that updates. Watching "fewer
 * than 5" turn into 5 the moment somebody walks in tells you they did (F14,
 * cf. SCRUM-472), and every arrival after that moves an exact number by one.
 * Ranges move only at their edges, so a single arrival is mostly invisible.
 * "20+" is a range too: an exact count of a big room still says who just came
 * in. Whether the room is over capacity is a separate flag, decided on the
 * exact figure, so safety does not depend on the number being shown.
 *
 * Zero is shown, as everywhere: an empty room names nobody.
 */
export function liveRange(count: number): LiveRange {
  if (count <= 0) return "0"
  if (count < MIN_CELL) return "a few"
  if (count < 10) return "5–9"
  if (count < 20) return "10–19"
  return "20+"
}

/**
 * A night's star rating, its average or its spread, or null below the
 * minimum cell (SCRUM-437).
 *
 * The app tells everyone who rates the night that it is "only ever seen by
 * us". An average of one rating is that person's score, printed beside a head
 * count of who came; an average of two lets either rater subtract their own
 * and read the other's. So every surface outside the database reads a rating
 * through here, and shows nothing until `MIN_CELL` people have rated.
 *
 * ponytail: the floor only. Five ratings in one bar still say what each of the
 * five gave; hold that back too if an event's raters are ever its whole room.
 */
export function discloseRating<T>(figure: T, raters: number): T | null {
  return raters < MIN_CELL ? null : figure
}

/** Ratings of 1 to 5 stars, counted per star. */
export type StarSpread = [number, number, number, number, number]

/**
 * A star spread as a host sees it: the bars, the average to one place, and how
 * many rated. Under `MIN_CELL` raters the bars are all zero and the average is
 * null, but the count stays, so a screen can say "not enough ratings yet"
 * rather than "nobody rated" (SCRUM-437).
 */
export function discloseStars(spread: StarSpread): {
  ratings: StarSpread
  averageRating: number | null
  ratingCount: number
} {
  const ratingCount = spread.reduce((a, b) => a + b, 0)
  const average = discloseRating(
    Math.round((spread.reduce((sum, n, i) => sum + n * (i + 1), 0) / ratingCount) * 10) / 10,
    ratingCount
  )
  return average === null
    ? { ratings: [0, 0, 0, 0, 0], averageRating: null, ratingCount }
    : { ratings: spread, averageRating: average, ratingCount }
}

/**
 * Stars across several events (an organisation's, a venue's), pooled only from
 * events that could show their own. Pool them all and a host subtracts an event
 * they can see from the total to read one they can't: the organisation's bars
 * minus a six-rater event's bars are a one-rater event's score (SCRUM-437).
 */
export function poolStars(perEvent: Iterable<StarSpread>): StarSpread {
  const pooled: StarSpread = [0, 0, 0, 0, 0]
  for (const spread of perEvent) {
    if (discloseStars(spread).averageRating === null) continue
    spread.forEach((n, i) => (pooled[i] += n))
  }
  return pooled
}

/**
 * Several events' stars as a host sees them: pooled from the events that pass
 * alone, and when none do, the count of every rating, so the screen says "not
 * enough ratings yet" rather than "nobody rated".
 */
export function discloseStarsAcross(perEvent: StarSpread[]): ReturnType<typeof discloseStars> {
  const stars = discloseStars(poolStars(perEvent))
  if (stars.averageRating !== null) return stars
  return { ...stars, ratingCount: perEvent.flat().reduce((a, b) => a + b, 0) }
}

/** `groupBy(["event_id", "rating"])` rows as one star spread per event. */
export function spreadsByEvent(rows: Array<{ event_id: string; rating: number; _count: { _all: number } }>): StarSpread[] {
  const byEvent = new Map<string, StarSpread>()
  for (const row of rows) {
    const spread = byEvent.get(row.event_id) ?? [0, 0, 0, 0, 0]
    if (row.rating >= 1 && row.rating <= 5) spread[row.rating - 1] = row._count._all
    byEvent.set(row.event_id, spread)
  }
  return [...byEvent.values()]
}

/**
 * May this *text* be shown, attributed to a pseudonym?
 *
 * Stricter than a count, and the register's sharpest finding is why: the
 * feedback digest hands an organiser verbatim message text with a **room-stable**
 * pseudonym and an exact timestamp, with no minimum cell at all. In a six-person
 * room, one `safety_conduct` message names its author to somebody who has seen
 * that pseudonym all night — and a safety concern is the one thing an attendee
 * most needs not to be identified for raising.
 *
 * A quote cannot be partially suppressed, so this is a boolean rather than a
 * figure. It applies the same population rules: a room too small, or a category
 * everybody contributed to, and the text stays out.
 *
 * Deliberately not `discloseFigure` with `count: 1`. The question is different —
 * publishing *a sentence somebody wrote* is not publishing a number they are
 * inside — and collapsing them would make the digest's rule invisible.
 */
export function mayQuote(input: {
  /** Distinct people who said something in this category. */
  contributors: number
  /** People in the room. */
  population: number
  floor?: number
}): boolean {
  return !discloseFigure({
    count: 1,
    contributors: input.contributors,
    population: input.population,
    floor: input.floor,
  }).suppressed
}

/* -------------------------------------------------------------------------- */
/* Breakdowns — a different question from a single figure                     */
/* -------------------------------------------------------------------------- */

/**
 * Merged here from the sponsors branch, rather than left as a second module.
 *
 * Both branches independently wrote a `lib/disclosure.ts` — #264 for
 * sponsor-facing breakdowns, #279 for the four-part rule the register said
 * already existed and did not. Two homes for one answer is the exact shape of
 * bug this whole audit is about, so they are one file.
 *
 * What survived from each: the four-part `discloseFigure` above, because
 * `connection-metrics.ts` and the feedback digest already call that signature
 * and it carries a `reason`; and the breakdown half below, because a set of
 * cells with a shared total leaks by subtraction in ways a single figure
 * cannot, and `poll-actions.ts` needs it. #264's two-argument `discloseFigure`
 * is gone — it was rules 1 and 4 of the four, and had no caller after the
 * merge.
 *
 * ER5 is satisfied: one module, floor 5 by default, per-metric override where
 * justified (`MIN_ATTENDEES = 8` is passed as `floor`, not hand-rolled).
 */
export type Disclosed<T> = T | null

export interface DisclosedBreakdown {
  /** Per-cell values in the caller's order. `null` where suppressed. */
  cells: Disclosed<number>[]
  /** `null` when any cell was suppressed. */
  total: Disclosed<number>
  /** True when anything at all was withheld — the UI copy depends on it. */
  suppressed: boolean
}

const FLOOR = SPONSORSHIP.MIN_REPORTABLE

/**
 * Apply the full rule to one group of counts.
 *
 * `alreadySuppressed` carries rule 4: pass the previous answer's `suppressed`
 * flag and the group stays hidden even if the numbers have since grown.
 */
export function discloseBreakdown(
  counts: number[],
  alreadySuppressed = false
): DisclosedBreakdown {
  const total = counts.reduce((a, b) => a + b, 0)

  // Rule 1.
  const visible = counts.map((n) => n >= FLOOR)

  // Rule 3: a lone survivor is the total minus the suppressed cells.
  if (visible.filter(Boolean).length === 1 && visible.length > 1) {
    const only = visible.indexOf(true)
    visible[only] = false
  }

  const anySuppressed = alreadySuppressed || visible.some((v) => !v)

  return {
    cells: counts.map((n, i) => (visible[i] && !alreadySuppressed ? n : null)),
    // Rule 2.
    total: anySuppressed ? null : total,
    suppressed: anySuppressed,
  }
}

/**
 * What to render in place of a withheld number.
 *
 * Centralised so two surfaces cannot describe the same suppression differently,
 * and so the copy never implies zero — "0 people" and "fewer than 5 people" are
 * different claims, and only one of them is true.
 */
export function suppressedLabel(kind: "figure" | "poll"): string {
  return kind === "poll"
    ? "Results appear once more people vote"
    : `Fewer than ${FLOOR} people — not reported`
}
