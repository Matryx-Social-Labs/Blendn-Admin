/**
 * How a date and time are written in a sentence the phone shows word for word.
 *
 * The app writes every date day-first ("Tue 29 Sep") and every time as "9 PM"
 * or "9:30 PM" (owner ruling: one time format). A server sentence in any other
 * form ("Tue, Sep 29, 9:00 PM") sits beside the app's own line and disagrees
 * with it. Mobile-facing messages take their dates from here.
 *
 * Dashboard strings do not: they have their own formats (`lib/dashboard-format.ts`).
 */

const PARTS: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
}

/** "Tue 29 Sep, 9 PM" / "Tue 29 Sep, 9:30 PM" in `timezone`, falling back to UTC for an unknown zone. */
export function mobileWhen(at: Date, timezone: string): string {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat("en-US", { ...PARTS, timeZone: timezone })
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", { ...PARTS, timeZone: "UTC" })
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    formatter.formatToParts(at).find((p) => p.type === type)?.value ?? ""
  const minute = part("minute")
  const clock = `${part("hour")}${minute === "00" ? "" : `:${minute}`} ${part("dayPeriod")}`
  return `${part("weekday")} ${part("day")} ${part("month")}, ${clock}`
}
