import { z } from "zod"

/**
 * A venue's opening hours as the venue page returns them (`venues.hours`):
 * one row per opening, `day` 0 (Sunday) to 6, wall-clock `HH:MM` in the
 * venue's own timezone. A close at or before the open runs past midnight.
 * Nothing writes the column yet; a value that is not this shape reads as
 * "not given" rather than breaking the page.
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
