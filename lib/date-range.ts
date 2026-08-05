/**
 * The global date range.
 *
 * Lives in the URL (`?range=30d`, or `?range=custom&from=…&to=…`) rather than in
 * React context, for three reasons that all matter here:
 *
 *   - **Server components read it.** Every dashboard page is a server component
 *     that queries the database directly; a context provider is invisible to
 *     them, so the range would have to be re-fetched client-side and the whole
 *     page would lose its server rendering.
 *   - **It survives a refresh** — an operator who narrows to a bad Tuesday and
 *     reloads keeps the Tuesday.
 *   - **It is shareable.** "Look at this" is a link, not a screenshot plus
 *     instructions.
 *
 * Pure functions only. Pinned by __tests__/date-range.test.ts.
 */

export type RangeKey = "today" | "7d" | "30d" | "90d" | "custom"

export const RANGE_PRESETS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "custom", label: "Custom" },
]

export const DEFAULT_RANGE: RangeKey = "30d"

export interface DateRange {
  key: RangeKey
  /** Inclusive start, at 00:00 local. */
  from: Date
  /** Exclusive end — always "now" or the end of the chosen day. */
  to: Date
}

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(d: Date): Date {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy
}

/** `YYYY-MM-DD` → local midnight, or null. Rejects impossible dates. */
export function parseISODate(value: string | undefined | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [y, m, d] = value.split("-").map(Number)
  const date = new Date(y, m - 1, d)
  // `new Date(2026, 1, 31)` silently becomes March 3rd. Round-trip to catch it.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

export function toISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Resolve URL params into a concrete window.
 *
 * Anything unparseable falls back to the default rather than throwing — a
 * hand-edited URL should show the dashboard, not an error page.
 */
export function resolveRange(
  params: { range?: string; from?: string; to?: string } = {},
  now = new Date()
): DateRange {
  const key = (RANGE_PRESETS.find((p) => p.key === params.range)?.key ?? DEFAULT_RANGE) as RangeKey

  if (key === "custom") {
    const from = parseISODate(params.from)
    const to = parseISODate(params.to)
    if (from && to) {
      // Swap rather than reject: a range dragged right-to-left is a valid
      // gesture, and refusing it would be pedantry.
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      // `to` is the END of the chosen day, or "Jan 5 → Jan 5" would be empty.
      return { key, from: lo, to: new Date(hi.getTime() + DAY_MS) }
    }
    // custom with no usable dates behaves as the default window.
    return resolveRange({ range: DEFAULT_RANGE }, now)
  }

  if (key === "today") return { key, from: startOfDay(now), to: now }

  // `days - 1`, because "last 7 days" means today and the six before it. Going
  // back a full 7 from midnight touches eight calendar days, which quietly
  // inflates every total by one day's worth.
  const days = key === "7d" ? 7 : key === "90d" ? 90 : 30
  return { key, from: new Date(startOfDay(now).getTime() - (days - 1) * DAY_MS), to: now }
}

/**
 * The window immediately before this one, same length.
 *
 * Powers "compare to previous period". Without it a single line answers "what
 * happened" and never "is that good".
 */
export function previousRange(range: DateRange): DateRange {
  const span = range.to.getTime() - range.from.getTime()
  return {
    key: range.key,
    from: new Date(range.from.getTime() - span),
    to: new Date(range.from.getTime()),
  }
}

/** What the control shows when the range is applied. */
export function rangeLabel(range: DateRange): string {
  if (range.key !== "custom") {
    return RANGE_PRESETS.find((p) => p.key === range.key)?.label ?? range.key
  }
  // `to` is exclusive; show the inclusive last day a human selected.
  const lastDay = new Date(range.to.getTime() - DAY_MS)
  return `${toISODate(range.from)} → ${toISODate(lastDay)}`
}

/**
 * Build the query string for a range, omitting anything at its default.
 *
 * A clean URL matters because these get shared — `?range=7d` reads, and
 * `?range=30d&from=&to=` does not.
 */
export function rangeToParams(key: RangeKey, custom?: { from: string; to: string }): URLSearchParams {
  const params = new URLSearchParams()
  if (key === "custom") {
    // A half-filled custom range writes nothing. Writing `range=custom` with a
    // missing date makes resolveRange fall back to the default, so the control
    // would say "custom" while the data showed 30 days.
    if (custom?.from && custom?.to) {
      params.set("range", "custom")
      params.set("from", custom.from)
      params.set("to", custom.to)
    }
  } else if (key !== DEFAULT_RANGE) {
    params.set("range", key)
  }
  return params
}
