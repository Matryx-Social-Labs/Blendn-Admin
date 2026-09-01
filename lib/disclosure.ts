import { SPONSORSHIP } from "@/lib/constants"

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
