// Relative imports: the venue-day sweeper (step 4) runs from server.ts, and
// `build:server` emits an @/ alias verbatim into the require().
import { randomUUID } from "crypto"
import { formatInTimeZone, fromZonedTime } from "date-fns-tz"

import { db } from "./db"
import { SYSTEM_USER_ID, venueDaysWhere } from "./event-kind"
import { validateGeofence } from "./geofence"
import { violatedConstraint } from "./prisma-errors"

/**
 * A venue day: the hidden `events` row a venue's live room hangs off.
 *
 * Every active venue is live from day one, claimed or not (owner decision D2).
 * Going live at a venue checks you into that venue's day — one row per venue
 * per local day, created the first time somebody goes live there — so the room,
 * check-ins, presence, moderation and the sweeper are the ones events already
 * have. What makes it different is who owns it and who may see it:
 *
 *   - **Owner: the system user** (`SYSTEM_USER_ID`), never a person (F2).
 *     `events.organizer_id` cascades on a hard delete; owned by whoever went
 *     live first, the day would vanish with their account, taking everybody
 *     else's check-ins and messages. The migration creates the user and a
 *     trigger refuses its deletion.
 *   - **`organizer_org_id`**: the venue's owning organisation once claimed,
 *     null before — the shape of a curated event, so an unclaimed venue's room
 *     is the platform's to moderate. `eventPermissions` never reads it for a
 *     venue day: the owner may moderate and never sees the people (F1, D-1).
 *   - **Host shown**: the venue's name (`lib/event-host.ts`).
 *   - **Never listed**: `kind = 'venue_day'`, which every events reader filters
 *     on (`lib/event-kind.ts`), and `unlisted`, so a feed that only asks for
 *     public events stays blind to it even if it forgot the kind.
 *   - **Area**: the venue's, copied at creation like any event at a venue
 *     (owner's ruling 3). A venue with no area gets a day with none, and Go
 *     Live refuses it there (step 4).
 *
 * The day starts at `venues.day_reset_hour` (06:00 by default) in
 * `venues.timezone`: somebody live at 02:00 is still in last night's room, and
 * the reset is what makes pseudonyms new each day.
 */

export { SYSTEM_USER_ID }

/** The partial unique index that makes one day per venue (migration SQL only). */
export const VENUE_DAY_INDEX = "events_one_venue_day_per_day"

const pad = (n: number) => String(n).padStart(2, "0")

function nextDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * The local day `now` falls in at a venue: `[start, end)` in UTC, and the
 * venue-local date it is named by.
 *
 * Counted in the venue's zone, never UTC (PL-U01): 05:59 belongs to yesterday
 * and 06:00 starts today, and across a DST change the day is 23 or 25 hours
 * long while both ends stay at the reset hour. Throws a RangeError for a zone
 * it cannot read (the database CHECK refuses those on write already).
 */
export function venueDayBounds(
  timeZone: string,
  resetHour: number,
  now: Date
): { localDate: string; start: Date; end: Date } {
  if (!Number.isInteger(resetHour) || resetHour < 0 || resetHour > 23) {
    throw new RangeError(`day_reset_hour out of range: ${resetHour}`)
  }
  const today = formatInTimeZone(now, timeZone, "yyyy-MM-dd")
  const hour = Number(formatInTimeZone(now, timeZone, "H"))
  let localDate = hour < resetHour ? nextDate(today, -1) : today
  const at = (date: string) => fromZonedTime(`${date}T${pad(resetHour)}:00:00`, timeZone)
  /*
   * A reset hour the clocks skip or repeat (02:00 on a DST change) resolves to
   * an instant an hour off the wall clock, which can leave `now` just outside
   * the day the hour pointed at. Step to the neighbouring day until it is
   * inside; each day still ends exactly where the next begins.
   */
  if (at(localDate) > now) localDate = nextDate(localDate, -1)
  else if (at(nextDate(localDate, 1)) <= now) localDate = nextDate(localDate, 1)
  return { localDate, start: at(localDate), end: at(nextDate(localDate, 1)) }
}

export interface VenueDay {
  id: string
  occurrenceId: string
  start_time: Date
  end_time: Date
}

const venueDaySelect = {
  id: true,
  start_time: true,
  end_time: true,
  occurrences: { select: { id: true }, take: 1 },
} as const

type Row = { id: string; start_time: Date; end_time: Date; occurrences: { id: string }[] }

function toVenueDay(row: Row): VenueDay {
  const occurrence = row.occurrences[0]
  if (!occurrence) throw new Error(`venue day ${row.id} has no occurrence`)
  return { id: row.id, occurrenceId: occurrence.id, start_time: row.start_time, end_time: row.end_time }
}

/**
 * The venue's day at `now`, created if this is the first time anybody needs it.
 *
 * Null when the venue does not exist, is deleted or archived — nothing to go
 * live in. Race-safe: two people going live at once both insert, the partial
 * unique index refuses the second, and the loser reads the winner's row. The
 * race is matched on the index's NAME through `violatedConstraint`, because
 * the driver adapter leaves `meta.target` empty here (memory: P2002 has no
 * target) — a check on the target would rethrow every lost race as a 500.
 *
 * A soft-deleted day is returned as it is: the index still holds its slot, and
 * whether a deleted day may be gone live in is the caller's decision (step 4).
 */
export async function venueDayFor(venueId: string, now: Date = new Date()): Promise<VenueDay | null> {
  const venue = await db.venues.findFirst({
    where: { id: venueId, deleted_at: null, status: "active" },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      latitude: true,
      longitude: true,
      geofence: true,
      owner_org_id: true,
      claimed_at: true,
      day_reset_hour: true,
      timezone: true,
    },
  })
  if (!venue) return null

  const { start, end, localDate } = venueDayBounds(venue.timezone, venue.day_reset_hour, now)
  const find = () =>
    db.events.findFirst({
      where: { ...venueDaysWhere, venue_id: venue.id, start_time: start },
      select: venueDaySelect,
    })

  const existing = await find()
  if (existing) return toVenueDay(existing)

  const fence = validateGeofence(venue.geofence)
  const eventId = randomUUID()
  try {
    const created = await db.$transaction(async (tx) => {
      await tx.events.create({
        data: {
          id: eventId,
          // Random, so the only unique index a race can hit is the venue-day one.
          slug: `venue-day-${eventId}`,
          kind: "venue_day",
          title: `Venue day · ${venue.name} · ${localDate}`,
          description: "",
          venue_id: venue.id,
          venue_name: venue.name,
          address: venue.address,
          city: venue.city,
          latitude: venue.latitude,
          longitude: venue.longitude,
          ...(fence.ok && { geofence: fence.fence }),
          start_time: start,
          end_time: end,
          timezone: venue.timezone,
          status: "published",
          visibility: "unlisted",
          organizer_id: SYSTEM_USER_ID,
          // A claim opens the venue's days from then on (ruling 1): a day that
          // began before the claim stays the platform's.
          organizer_org_id: venue.owner_org_id && venue.claimed_at && venue.claimed_at <= start ? venue.owner_org_id : null,
        },
      })
      await tx.event_occurrences.create({
        data: { event_id: eventId, occurs_on: new Date(`${localDate}T00:00:00Z`), start_time: start, end_time: end },
      })
      return tx.events.findUniqueOrThrow({ where: { id: eventId }, select: venueDaySelect })
    })
    return toVenueDay(created)
  } catch (error) {
    if (!violatedConstraint(error, VENUE_DAY_INDEX)) throw error
    const winner = await find()
    if (!winner) throw error
    return toVenueDay(winner)
  }
}
