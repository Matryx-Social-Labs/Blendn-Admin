// Relative imports: the venue-day sweeper reads this from server.ts, and
// `build:server` emits an @/ alias verbatim into the require().
import type { Prisma } from "@prisma/client"

import { realEventsWhere } from "./event-kind"

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
