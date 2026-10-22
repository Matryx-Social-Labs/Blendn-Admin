import { venueDayBounds } from "@/lib/venue-day"
import { venueHours } from "@/lib/venue-hours"

/** Tonight's opening, wall-clock `HH:MM` in the venue's own zone (`venues.hours`). */
export interface TonightHours {
  opensAt: string
  closesAt: string
}

type HoursSource = { timezone: string; day_reset_hour: number; hours: unknown }

/**
 * The hours row for the weekday of the venue's current day, or null (no hours
 * given, or none for this weekday). "Tonight" is the venue's day, not the
 * clock's midnight: at 01:00 on Saturday a venue that resets at 06:00 is still
 * in Friday's day, and Friday's row answers. A close at or before the open runs
 * past midnight, as `venueHoursSchema` says; it is passed through as written.
 *
 * The one reading of "open by hours": `isOpenByHours` in the Places tiers is
 * `tonightHours(...) !== null`, so the tier and the line on the card agree.
 *
 * ponytail: a split day (lunch and dinner rows) answers with its latest opening,
 * the evening one; the card has one line. A second shape if a venue needs both.
 */
export function tonightHours(v: HoursSource, now: Date): TonightHours | null {
  const { localDate, end } = venueDayBounds(v.timezone, v.day_reset_hour, now)
  if (end <= now) return null
  const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay()
  const rows = venueHours(v.hours)?.filter((h) => h.day === weekday) ?? []
  if (rows.length === 0) return null
  const latest = rows.reduce((a, b) => (b.open > a.open ? b : a))
  return { opensAt: latest.open, closesAt: latest.close }
}
