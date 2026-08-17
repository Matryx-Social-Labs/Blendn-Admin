import { SPONSORSHIP } from "@/lib/constants"

/**
 * Suppressing small numbers so they describe people instead of naming them.
 *
 * ## Why a floor alone is not enough
 *
 * The obvious rule — hide any count below `MIN_REPORTABLE` — leaks by
 * subtraction. Three ways, all of which have to be closed together:
 *
 * ```
 *   total 142, options [98, 41, 3]        hide the 3
 *     -> 142 - 98 - 41 = 3                recovered from the total
 *
 *   total 45, options [42, 3]             hide the 3
 *     -> one cell left standing at 42     the survivor IS the complement
 *
 *   at close: "fewer than 5"              later, campaign grows
 *     -> republished as 7                 the earlier suppression is undone
 * ```
 *
 * So the rule is four parts, and every one of them is load-bearing:
 *
 *   1. suppress any cell below the floor
 *   2. if ANY cell is suppressed, suppress the group total too
 *   3. if suppression leaves exactly one cell visible, suppress that one as
 *      well — it is recoverable from the total by definition
 *   4. suppression is sticky: a figure hidden once is not republished because
 *      the number later grew
 *
 * Rule 3 is the one that gets forgotten, and rule 2 is the one that makes
 * rule 1 worth anything.
 *
 * ## Where this applies
 *
 * `DESIGN_HANDOFF.md` guarantees small rooms are normal: check-in never
 * refuses, so capacity is a signal and not a door. In a room of six, "1 vote ·
 * Leaving early" names that person to everyone still there. The same reasoning
 * covers sponsor-facing reach, which additionally stops a sponsor being billed
 * against a three-person room.
 *
 * Pure by design — no database, no I/O — so every caller (socket emission, REST
 * payload, CSV export, the charts) reads the same answer. Raw counts must never
 * leave the module that calls this.
 */

/** A value that may be withheld. `null` means "not reportable", not "zero". */
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
 * A single sponsor-facing figure — reach, exposures, spend-per-head.
 *
 * Separate from the breakdown because there is no complement to protect: one
 * number stands alone, so only rules 1 and 4 apply.
 */
export function discloseFigure(
  value: number,
  alreadySuppressed = false
): Disclosed<number> {
  if (alreadySuppressed) return null
  return value >= FLOOR ? value : null
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
