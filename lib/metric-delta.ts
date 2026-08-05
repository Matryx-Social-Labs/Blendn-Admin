/**
 * Period-over-period change, as a percentage.
 *
 * The design puts a delta badge on the overview tiles and the data layer never
 * computed one, so every tile rendered a bare number with no sense of
 * direction. A count with no comparison answers "how many" and never "is that
 * good", which is the only question an operator actually has.
 *
 * The hard case is a zero baseline, and it is the *common* case here — at 44
 * users most previous windows are genuinely empty. Going from 0 to 5 is not
 * "+500%" and it is certainly not "+∞%": there is no baseline, so there is no
 * percentage. `null` says that, and `DeltaBadge` renders it as an em dash.
 * Inventing a number for it would put a wrong figure on the busiest screen.
 *
 * Pinned by __tests__/metric-delta.test.ts.
 */

/**
 * @returns whole-percent change, or `null` when no honest percentage exists.
 */
export function percentDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null

  // No baseline. 0 → 5 has no percentage, and 0 → 0 has no change to report.
  if (previous === 0) return null

  // Rounded to a whole percent: the underlying counts are small enough that a
  // decimal implies a precision the number does not have.
  return Math.round(((current - previous) / previous) * 100)
}

/**
 * The label for a change that has no percentage but is still worth showing.
 *
 * `percentDelta` returns null for both "0 → 0" (nothing happened) and "0 → 5"
 * (something started). Those are different facts and the tile should not render
 * an identical em dash for each.
 */
export function deltaHint(current: number, previous: number): string | undefined {
  if (previous !== 0) return undefined
  if (current > 0) return "new"
  return undefined
}

/** A metric and the same metric one window earlier. */
export interface MetricPair {
  current: number
  previous: number
}

/** Convenience for the overview builders: pair → what the tile needs. */
export function tileDelta(pair: MetricPair): { delta?: number; hint?: string } {
  const delta = percentDelta(pair.current, pair.previous)
  return {
    ...(delta === null ? {} : { delta }),
    ...(deltaHint(pair.current, pair.previous) ? { hint: deltaHint(pair.current, pair.previous) } : {}),
  }
}
