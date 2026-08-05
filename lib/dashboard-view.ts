/**
 * Presentation maths for the dashboard. Framework-free on purpose so it can be
 * tested without rendering recharts.
 */

/**
 * Width of a proportional bar, as a percentage of the largest value.
 *
 * Used by every hand-drawn bar in the dashboard — the activation funnel and the
 * rating distribution — so the zero rule is enforced in one place.
 *
 * An earlier version was `Math.max(10, (value / max) * 100)`, which drew a
 * funnel stage with zero people as if it had a tenth of the traffic of the best
 * one. On a funnel that is the single number you cannot fudge: "nobody reached
 * this stage" has to look like nothing.
 *
 * A non-zero value still gets a small floor so one check-in out of fifty
 * thousand renders as a visible sliver rather than disappearing. That is a
 * rounding courtesy for values already above zero, not an invented minimum.
 */
export function barWidth(value: number, max: number, floorPct = 2): number {
  if (value <= 0 || max <= 0) return 0
  return Math.min(100, Math.max(floorPct, (value / max) * 100))
}
