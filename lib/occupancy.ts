import { db } from "@/lib/db"

/**
 * Who is in the room, and who came.
 *
 * `events.current_capacity` used to answer both, plus "what does the room
 * hold", from one stored counter. Three jobs, one number, and they contradict:
 *
 *   capacity    what the room holds        never changes during the event
 *   occupancy   who is in it right now     changes constantly
 *   attendance  who came at all            only ever goes up
 *
 * The counter was incremented on check-in and decremented on checkout, which
 * meant every write path had to maintain it and any missed path drifted for
 * ever. Two bugs shipped from that in a single day.
 *
 * `lib/live-snapshot.ts` had already worked this out and counts directly,
 * saying so in its own comment — "a counter held in the process is wrong after
 * any restart, and wrong in a way nobody notices until an alert fails to fire."
 * The same is true of a counter held in a column. This finishes that pattern
 * everywhere else.
 *
 * Every count here is served by `@@index([event_id, status])`, which already
 * existed.
 */

export interface Occupancy {
  /** Everyone currently inside — staff included. Fire safety counts bodies. */
  inside: number
  /** Of those, the ones who are not running the event. */
  guestsInside: number
  staffInside: number
  /** Distinct guests who ever checked in. Staff excluded — they are not attendees. */
  uniqueAttendance: number
  capacity: number | null
  /** Null when no capacity is set: an event with none has no fill to report. */
  fillPct: number | null
  /**
   * Over its stated capacity.
   *
   * Deliberately a signal rather than an error. Check-in no longer refuses at
   * capacity — the geofence covers the queue outside, so the hundred-and-first
   * arrival is standing at the door, and turning them away denies them the
   * chatroom and erases them from attendance. A room over its stated size is
   * something the organiser should *see*, which the old design made impossible.
   */
  overCapacity: boolean
}

export async function getOccupancy(eventId: string): Promise<Occupancy> {
  const [event, inside, staffInside, uniqueGuests] = await Promise.all([
    db.events.findUnique({
      where: { id: eventId },
      select: { max_capacity: true },
    }),
    db.event_check_ins.count({
      where: { event_id: eventId, status: "checked_in" },
    }),
    db.event_check_ins.count({
      where: { event_id: eventId, status: "checked_in", kind: "staff" },
    }),
    db.event_check_ins.findMany({
      where: { event_id: eventId, kind: "attendee", check_in_time: { not: null } },
      distinct: ["user_id"],
      select: { user_id: true },
    }),
  ])

  const capacity = event?.max_capacity ?? null
  const guestsInside = inside - staffInside

  return {
    inside,
    guestsInside,
    staffInside,
    uniqueAttendance: uniqueGuests.length,
    capacity,
    // Guests against capacity: the room is sized for the audience, and counting
    // the four staff towards "sold out" would be wrong.
    fillPct: capacity === null ? null : Math.round((guestsInside / capacity) * 100),
    overCapacity: capacity !== null && guestsInside > capacity,
  }
}

/**
 * Occupancy for several events at once.
 *
 * The chatrooms screen sums "audience on site" across every live event, and
 * doing that with one query per event would be a loop over the network.
 */
export async function getOccupancies(
  eventIds: string[]
): Promise<Map<string, { inside: number; guestsInside: number }>> {
  const out = new Map<string, { inside: number; guestsInside: number }>()
  if (eventIds.length === 0) return out

  const rows = await db.event_check_ins.groupBy({
    by: ["event_id", "kind"],
    where: { event_id: { in: eventIds }, status: "checked_in" },
    _count: { _all: true },
  })

  for (const id of eventIds) out.set(id, { inside: 0, guestsInside: 0 })
  for (const row of rows) {
    const entry = out.get(row.event_id)!
    entry.inside += row._count._all
    if (row.kind === "attendee") entry.guestsInside += row._count._all
  }
  return out
}
