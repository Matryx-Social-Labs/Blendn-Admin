// Relative imports: the venue-day sweeper reads this from server.ts, and
// `build:server` emits an @/ alias verbatim into the require().
import type { Prisma } from "@prisma/client"

import { db } from "./db"
import { realEventsWhere } from "./event-kind"
import { distanceToGeofence, eventCentre, validateGeofence, type Geofence } from "./geofence"

/**
 * When a real event takes a venue over (plan v2 step 2's hiding rule, written
 * once here so Go Live, the venue-day sweeper and the Places list agree).
 *
 * From an hour before a linked event starts until it ends, the venue is the
 * event's: Places hides the venue (step 2 wires the list), Go Live there is
 * refused with `EVENT_LIVE_HERE` so the person checks in to the event
 * instead, and at the start the venue's open Go Live sessions are closed and
 * told the event has started (the venue-day sweeper).
 *
 * Which events: real (never a venue day — a venue going live must not hide
 * itself, F3), published, public (a private event's start closes nothing and
 * names itself to nobody), not deleted, linked to the venue with a link nobody
 * disputed, and per occurrence (D-2): a day of a run that was called off takes
 * nothing over. And, for a viewer, one they may attend (D-3): a 21+ night does
 * not refuse a 19-year-old's Go Live in favour of an event they cannot enter.
 */

/** How long before a linked event starts it takes its venue over. */
export const TAKEOVER_LEAD_MINUTES = 60

/**
 * The `where` for events taking their venue over at `now`; the caller adds
 * `venue_id`. `leadMinutes: 0` asks "started and not yet ended".
 *
 * The link status is spelled out with an explicit NULL branch: a bare
 * `not: "disputed"` drops every NULL row in Prisma (memory: Prisma `not`
 * excludes NULL), and an event linked before the status existed is linked.
 * Both ORs sit under `AND`, so neither replaces the other (F4).
 */
export function venueTakeoverWhere(
  now: Date,
  opts: { leadMinutes?: number; viewerAge?: number | null } = {}
): Prisma.eventsWhereInput {
  const lead = opts.leadMinutes ?? TAKEOVER_LEAD_MINUTES
  return {
    ...realEventsWhere,
    deleted_at: null,
    status: "published",
    visibility: "public",
    AND: [
      { OR: [{ venue_link_status: null }, { venue_link_status: { not: "disputed" } }] },
      ...(typeof opts.viewerAge === "number"
        ? [{ OR: [{ min_age: null }, { min_age: { lte: opts.viewerAge } }] }]
        : []),
    ],
    occurrences: {
      some: {
        cancelled_at: null,
        start_time: { lte: new Date(now.getTime() + lead * 60_000) },
        end_time: { gt: now },
      },
    },
  }
}

/**
 * Whether a candidate from `venueTakeoverWhere` really is at the venue
 * (D-x3, step 4 review).
 *
 * Any organiser can link a public event to any venue, and a link made by
 * picking the venue starts `auto_linked` — so the link alone would let a
 * stranger refuse Go Live at somebody else's venue for an evening and close
 * everybody live there. A takeover therefore needs the venue's owner to have
 * confirmed the link, or the event's own area to sit at the venue: its centre
 * inside the venue's area and buffer. An event with no area of its own, at a
 * venue with none, takes nothing over until it is confirmed.
 */
export function atTheVenue(
  event: {
    venue_link_status: "auto_linked" | "confirmed" | "disputed" | null
    geofence: unknown
    latitude: number | null
    longitude: number | null
  },
  venueGeofence: unknown
): boolean {
  if (event.venue_link_status === "confirmed") return true
  const area = validateGeofence(venueGeofence)
  const centre = eventCentre(event.geofence, event.latitude, event.longitude)
  if (!area.ok || !centre) return false
  return distanceToGeofence(centre, area.fence) <= area.fence.buffer
}

/** What `atTheVenue` needs from an event row. */
export const takeoverSelect = {
  id: true,
  title: true,
  venue_id: true,
  venue_link_status: true,
  geofence: true,
  latitude: true,
  longitude: true,
} as const

/**
 * The event taking this venue over at `now`, if any — `venueTakeoverWhere`
 * and `atTheVenue` together, for one venue.
 */
export async function eventTakingOver(
  venueId: string,
  now: Date,
  opts: { leadMinutes?: number; viewerAge?: number | null } = {}
): Promise<{ id: string; title: string } | null> {
  const venue = await db.venues.findUnique({ where: { id: venueId }, select: { geofence: true } })
  if (!venue) return null
  const candidates = await db.events.findMany({
    where: { venue_id: venueId, ...venueTakeoverWhere(now, opts) },
    orderBy: { start_time: "asc" },
    // A venue hosts a handful of events in any hour; this bounds a bad night.
    take: 20,
    select: takeoverSelect,
  })
  const event = candidates.find((e) => atTheVenue(e, venue.geofence))
  return event ? { id: event.id, title: event.title } : null
}

/**
 * The area Go Live is judged against at a venue: the one today's day copied
 * when it was made (owner's ruling 3: nothing moves an area under a room), or
 * the venue's own when nobody has gone live yet. Validated, never the legacy
 * point-and-radius: a venue nobody drew an area for has none. One answer for
 * `POST /venues/:id/live` and `GET /venues/:id`.
 */
export function goLiveArea(day: { geofence: unknown } | null, venue: { geofence: unknown }): Geofence | null {
  const area = validateGeofence(day ? day.geofence : venue.geofence)
  return area.ok ? area.fence : null
}
