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

/** Relative date for an upcoming event. Days out is already floored at 0. */
export function formatCountdown(daysOut: number): string {
  if (daysOut <= 0) return "Today"
  if (daysOut === 1) return "Tomorrow"
  return `In ${daysOut} days`
}

/**
 * Tailwind class for an event's capacity bar, chosen by how much attention it
 * needs rather than by brand rotation — the point of the bar is to make a
 * nearly empty event with a near date stand out from a full one.
 *
 * `null` means the event stated no capacity, which is not the same as empty:
 * there is no target to be short of, so it renders neutral.
 */
export function fillTone(fillPct: number | null): string {
  if (fillPct === null) return "bg-muted-foreground/40"
  if (fillPct >= 80) return "bg-success"
  if (fillPct >= 25) return "bg-chart-1"
  return "bg-destructive"
}
