import { fromZonedTime } from "date-fns-tz"

/**
 * A `datetime-local` value from an event form, read as wall-clock time where
 * the event happens, as a UTC ISO string. Never `new Date(value)`: that reads
 * it in the browser's zone, which is not the event's when an admin curates a
 * city they are not in (SCRUM-453).
 */
export function wallClockToUtc(local: string, timezone: string): string {
  return fromZonedTime(local, timezone).toISOString()
}
