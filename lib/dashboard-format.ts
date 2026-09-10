/**
 * Formatting shared by every dashboard screen. Framework-free so it can be
 * tested without rendering.
 */

const numberFormat = new Intl.NumberFormat("en-US")
const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const dayFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  day: "numeric",
  month: "short",
})

export function formatNumber(value: number | null) {
  return value === null ? "—" : numberFormat.format(value)
}

export function formatCompact(value: number | null) {
  return value === null ? "—" : compactFormat.format(value)
}

export function formatDay(iso: string) {
  return dayFormat.format(new Date(iso))
}

/**
 * `null` renders an em dash, not "0%".
 *
 * The distinction is load-bearing across this dashboard: an event with no
 * stated capacity has no fill percentage, which is not the same as being empty.
 */
export function formatPct(value: number | null) {
  return value === null ? "—" : `${Math.round(value)}%`
}

/** Relative age for queue items, where age is the SLA. */
export function formatAge(hours: number | null) {
  if (hours === null) return "—"
  if (hours < 1) return "just now"
  if (hours < 24) return `${Math.floor(hours)}h`
  return `${Math.floor(hours / 24)}d`
}

/** Relative "time since", or null for never. */
export function formatSince(iso: string | null) {
  if (!iso) return "never"
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000))
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

export function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "published") return "default"
  if (status === "cancelled") return "destructive"
  return "secondary"
}

/* -------------------------------------------------------------------------- */

/**
 * One column for when, not two.
 *
 * Start and end were separate columns each rendering the full
 * "Sep 9, 2026, 11:57 AM" — the year twice and the date twice on every row, for
 * a fact that is one date and a duration. At seventeen rows that is a quarter
 * of the table's width spent repeating 2026.
 *
 * Formatted here rather than in the client component for two reasons that are
 * really one: `new Date()` inside a render is an impure call (the React
 * Compiler says so), and server and client can disagree about the year across
 * a New Year boundary, which is a hydration mismatch nobody will ever
 * reproduce. Same fix as `generatedAt` on the overview — compute it once, on
 * the server, and send the string.
 */
export function whenLabel(start: Date, end: Date, now: Date): string {
  /*
   * The year only when it is not this one. A list of 2026 events read on a 2026
   * afternoon does not need telling — but an event that CROSSES new year does,
   * on both halves.
   *
   * The first version applied the rule to the start date alone and hardcoded
   * the end date with no year, so a 31 Dec → 2 Jan run rendered as
   * "31 Dec → 2 Jan": two dates a year apart, drawn as though they were two
   * days apart, on the column an admin scans to find an event by when it is.
   * Found by a coverage pass, not by looking at the screen — the seed has no
   * event spanning a new year, so nothing on any staging screenshot could have
   * shown it.
   */
  const day = (date: Date, showYear: boolean) =>
    date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...(showYear ? { year: "numeric" } : {}),
    })

  const crossesYears = start.getFullYear() !== end.getFullYear()
  const showStartYear = start.getFullYear() !== now.getFullYear() || crossesYears
  const showEndYear = end.getFullYear() !== now.getFullYear() || crossesYears

  if (start.toDateString() !== end.toDateString()) {
    return `${day(start, showStartYear)} → ${day(end, showEndYear)}`
  }
  const from = start.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" })
  return `${day(start, showStartYear)}, ${from}`
}

/**
 * Every event this person may see.
 *
 * ## Why this is a server component now
 *
 * It was the last screen in the dashboard that fetched its own data from a
 * client `useEffect`, and that one decision produced most of what was wrong
 * with it: a **"Loading events…" spinner inside a bordered card**, on a
 * codebase whose design system says skeletons rather than spinners and which
 * already had `app/dashboard/events/loading.tsx` sitting unused — the boundary
 * can never fire for a component that does not suspend.
 *
 * It also meant a second copy of the row shape, and a second answer to "which
 * events may I see": the route it called had careful organisation-membership
 * scoping with a comment explaining the colleague-sees-an-empty-list bug, and
 * nothing held the dashboard to it. `lib/event-visibility.ts` is now the only
 * answer, used by both.
 *
 * ## What the columns are for
 *
 * An admin opens this to find one event, or to see what is broken. So: when,
 * where, whose, and whether it can actually be checked into. **Capacity is
 * gone** — it rendered `current_capacity`, which has no application writer and
 * was `0` on every row for every event ever created (K4.12). A column of zeroes
 * is not a neutral omission; it is a metric asserting that nobody came.
 */

/* -------------------------------------------------------------------------- */

/**
 * What to say after deleting a selection, when some of it failed.
 *
 * A pure function rather than three inline ternaries, for the reason
 * `lib/row-count-label.ts` exists: the interesting branch here is the PARTIAL
 * one, and it is genuinely reachable — `DELETE /api/events/[id]` authorizes per
 * row through `eventPermissions().canEdit`, so a mixed selection is a normal
 * outcome rather than a network freak. Inline, it could only be tested by
 * rendering a component and reading a toast, which this repo has no harness
 * for; extracted, it is four assertions.
 *
 * Partial failure is stated with both numbers because "could not delete those
 * events" over a selection where four of five went is worse than saying
 * nothing: the operator re-selects and deletes four rows that are already gone.
 */
export function bulkDeleteMessage(
  attempted: number,
  failed: number
): { tone: "success" | "error"; text: string } {
  if (failed === 0) {
    return {
      tone: "success",
      text: `Deleted ${attempted} event${attempted === 1 ? "" : "s"}`,
    }
  }
  if (failed === attempted) {
    return {
      tone: "error",
      text: attempted === 1 ? "Could not delete that event" : "Could not delete those events",
    }
  }
  return {
    tone: "error",
    text: `Deleted ${attempted - failed}, but ${failed} could not be removed`,
  }
}
