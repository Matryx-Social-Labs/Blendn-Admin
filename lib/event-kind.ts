/**
 * The two kinds of `events` row, as `where` fragments.
 *
 * A venue day (`lib/venue-day.ts`) is an events row so that it can reuse
 * occurrences, check-ins, presence and the chat room — and for the same reason
 * it looks like a published night out to every reader that does not ask. Spread
 * `realEventsWhere` into any read that means "events a host runs": the feed,
 * search, a host's numbers, reminders, exports, seeds. Readers that want venue
 * days say so with `venueDaysWhere`, or with an `any-kind:` comment saying why
 * both belong.
 *
 * `__tests__/events-kind-boundary.test.ts` holds every reader to one of those.
 * Raw SQL writes the predicate itself: `kind = 'event'`.
 *
 * Only `kind`, so spreading it next to any other filter — an `OR`, an `AND` —
 * can never replace one of its keys.
 */
export const realEventsWhere = { kind: "event" } as const

export const venueDaysWhere = { kind: "venue_day" } as const

/**
 * "In this room", for a check-in lookup on one event.
 *
 * At a real event, any check-in: attendance outlives presence, and the roster,
 * the grid and the room stay open to somebody who stepped out (`mayWriteToRoom`).
 * At a venue day, only a Go Live window still open. The venue's room, roster
 * and grid are reciprocal — you see the people live there only while you are
 * live there yourself (docs/HOTSPOTS.md) — so an ended window is no seat at
 * all. Compared with the clock, not left to the sweeper.
 *
 * Wrapped in `AND`, so spreading it beside another `OR` replaces nothing.
 */
export function inRoomWhere(now: Date = new Date()) {
  return {
    AND: [{ OR: [{ event: realEventsWhere }, { status: "checked_in" as const, expires_at: { gt: now } }] }],
  }
}

/**
 * The owner of every venue day (`lib/venue-day.ts`), created by the migration
 * `20261001220000_venue_days`. Never a person, never signed into: here rather
 * than in `lib/venue-day.ts` so the auth code can refuse it without importing
 * the database.
 */
export const SYSTEM_USER_ID = "blendn-system"
