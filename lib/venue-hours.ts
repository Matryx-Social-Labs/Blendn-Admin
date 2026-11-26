import { z } from "zod"

/**
 * A venue's opening hours as the venue page returns them (`venues.hours`):
 * one row per opening, `day` 0 (Sunday) to 6, wall-clock `HH:MM` in the
 * venue's own timezone. A close at or before the open runs past midnight.
 * Written by `setVenueHours` (`lib/venue-actions.ts`); a value that is not this
 * shape reads as "not given" rather than breaking the page.
 */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const venueHoursSchema = z
  .array(z.object({ day: z.number().int().min(0).max(6), open: clock, close: clock }).strict())
  .max(21)

export type VenueHours = z.infer<typeof venueHoursSchema>

export function venueHours(raw: unknown): VenueHours | null {
  const parsed = venueHoursSchema.safeParse(raw)
  return parsed.success && parsed.data.length > 0 ? parsed.data : null
}

/** Sunday first, as `day` counts. */
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const

/**
 * One opening a day. The readers answer "tonight" with one row (a split day's
 * later opening: `tonightHours` here, `tonightOpening` in the app at
 * origin/stage), so a lunch opening would read "Opens 7 PM" while the venue is
 * open. Raise it when the app reads split days.
 */
export const MAX_OPENINGS_PER_DAY = 1

interface HoursProblem {
  /** The row's index in what was given. */
  index: number
  field: "open" | "close"
  message: string
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
const pad = (hour: number) => `${String(hour).padStart(2, "0")}:00`

/**
 * What the editor refuses, beyond the shape: every value here is one the
 * readers would place on the wrong night or say wrong. The venue's day starts
 * at `resetHour` (`venues.day_reset_hour`), and both the server and the app
 * read "tonight" as the rows of the venue's current day, so each opening must
 * sit inside one venue day: it opens at or after the reset, and a close past
 * midnight comes by the next reset. That also keeps one day's night out of the
 * next day's opening, so openings on different days cannot overlap. A close
 * equal to the open would read as open until the reset. Empty: nothing wrong.
 */
export function hoursProblems(rows: VenueHours, resetHour: number): HoursProblem[] {
  const reset = resetHour * 60
  const seen = new Map<number, VenueHours>()
  const problems: HoursProblem[] = []
  rows.forEach((row, index) => {
    const day = DAY_NAMES[row.day]
    const open = minutesOf(row.open)
    const close = minutesOf(row.close)
    const before = seen.get(row.day) ?? []
    if (before.length >= MAX_OPENINGS_PER_DAY) {
      problems.push({ index, field: "open", message: `${day} already opens ${before[0].open} to ${before[0].close}. The app shows one opening a day, so make it one opening.` })
      return
    }
    seen.set(row.day, [...before, row])
    if (open < reset) {
      problems.push({ index, field: "open", message: `${day} opens at ${row.open}, before the venue’s day starts at ${pad(resetHour)}.` })
    } else if (close === open) {
      problems.push({ index, field: "close", message: `${day} closes at the time it opens.` })
    } else if (close < open && close > reset) {
      problems.push({ index, field: "close", message: `${day} runs to ${row.close}, past ${pad(resetHour)} on ${DAY_NAMES[(row.day + 1) % 7]}, when the venue’s next day starts. Close by ${pad(resetHour)}.` })
    }
  })
  return problems
}
