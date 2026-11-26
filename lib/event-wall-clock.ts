import { formatInTimeZone, fromZonedTime } from "date-fns-tz"
// Relative: reached from server.ts through the reminder sweeper, and build:server emits `@/` verbatim.
import { eventClock } from "./event-phase"

/**
 * A `datetime-local` value from an event form, read as wall-clock time where
 * the event happens, as a UTC ISO string. Never `new Date(value)`: that reads
 * it in the browser's zone, which is not the event's when an admin curates a
 * city they are not in (SCRUM-453).
 */
export function wallClockToUtc(local: string, timezone: string): string {
  return fromZonedTime(local, timezone).toISOString()
}

/**
 * The first `hour:00` on `timeZone`'s clock strictly after `after`: "Rate the
 * night" at 10:00 the morning after (SCRUM-1274). DST-safe, because the hour is
 * resolved on the day it falls, not by adding 24 h. A zone the runtime does not
 * know reads as UTC, the rule the event's own pages use (`eventClock`).
 */
export function nextLocalTime(after: Date, timeZone: string, hour: number): Date {
  const { zone } = eventClock(timeZone)
  const at = (day: string) => fromZonedTime(`${day}T${String(hour).padStart(2, "0")}:00:00`, zone)
  const day = formatInTimeZone(after, zone, "yyyy-MM-dd")
  const sameDay = at(day)
  if (sameDay > after) return sameDay
  const [y, m, d] = day.split("-").map(Number)
  return at(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10))
}
