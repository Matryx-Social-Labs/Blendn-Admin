/**
 * Presentation maths for the dashboard. Framework-free on purpose so it can be
 * tested without rendering recharts.
 */

/**
 * Width of a funnel stage's filled bar, as a percentage of the largest stage.
 *
 * The previous version was `Math.max(10, (value / max) * 100)`, which drew a
 * stage with zero events as if it had a tenth of the traffic of the best one.
 * On a funnel that is the single number you cannot fudge — "0 people reached
 * this stage" has to look like zero.
 *
 * A non-zero stage still gets a 2% floor so that one check-in out of fifty
 * thousand renders as a visible sliver rather than nothing at all. That is a
 * rounding courtesy, not an invented value: it only ever applies where the
 * real value is already above zero.
 */
export function funnelBarWidth(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  return Math.min(100, Math.max(2, (value / max) * 100))
}
