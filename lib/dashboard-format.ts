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
