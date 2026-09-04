// Relative, not "@/lib/db". `lib/live-snapshot.ts` imports the arithmetic below
// and is reachable from server.ts, which `build:server` compiles with plain tsc
// — that resolves the @/ alias for typechecking and then emits it verbatim into
// the require(), so the build goes green and the container dies on boot.
import { db } from "./db"
import { headcount, cutoffFrom } from "./presence-sessions"
import { resolveOccurrence } from "./occurrences"

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

/**
 * The arithmetic, separated from the queries.
 *
 * `lib/live-snapshot.ts` already has every check-in row in memory and would
 * otherwise redo this by hand — which is exactly how the live tab came to cap
 * fill at 100% and measure it against staff-inclusive occupancy while this file
 * measured guests and reported the breach. Two screens, one room, two answers.
 * One implementation is the only thing that stops that recurring.
 */
export function occupancyFrom({
  inside,
  staffInside,
  uniqueAttendance,
  capacity,
}: {
  inside: number
  staffInside: number
  uniqueAttendance: number
  capacity: number | null
}): Occupancy {
  const guestsInside = inside - staffInside
  return {
    inside,
    guestsInside,
    staffInside,
    uniqueAttendance,
    capacity,
    // Guests against capacity: the room is sized for the audience, and counting
    // the four staff towards "sold out" would be wrong.
    //
    // Uncapped, deliberately. Clamping to 100 is what made a room over its
    // stated size unrepresentable, and that room is the entire crowd-safety
    // moment this product is positioned around.
    fillPct: capacity === null || capacity === 0 ? null : Math.round((guestsInside / capacity) * 100),
    overCapacity: capacity !== null && capacity > 0 && guestsInside > capacity,
  }
}

/**
 * The capacity that applies **today**.
 *
 * `event_occurrences.capacity` existed from the multi-day work and was read by
 * nothing, so a conference whose last day moves to a smaller room had its fill
 * measured against the whole run's number — over-capacity on the day it mattered
 * was invisible, which is the one thing the occupancy work exists to surface.
 *
 * Falls back to the event's, which is the common case: most events state one
 * capacity and every day of them holds it.
 *
 * Resolved through `resolveOccurrence` — the same function check-in uses to
 * decide which day someone is checking in to. Two implementations of "which day
 * is it" would eventually disagree about a club night that runs past midnight.
 */
function capacityForNow(
  slot: Awaited<ReturnType<typeof resolveOccurrence>>,
  eventCapacity: number | null
): number | null {
  // `ok: false` still carries the occurrence when the reason is timing rather
  // than absence — an event between days should still measure against the day
  // it is between, not lose its capacity entirely.
  //
  // Takes the resolved slot rather than resolving its own: `getOccupancy` needs
  // the same answer to scope its counts, and asking twice is how the counts and
  // the capacity came to disagree in the first place.
  return slot.occurrence?.capacity ?? eventCapacity
}

export async function getOccupancy(eventId: string): Promise<Occupancy> {
  /*
   * Resolved once, and used for the counts as well as the capacity.
   *
   * `capacityForNow` already asked which day it is, and the counts did not —
   * so capacity was per-occurrence while occupancy was across every day of the
   * run. On day three of a conference, a day-one attendee whose row is still
   * `checked_in` counted as inside, against day three's capacity.
   *
   * Rows go stale exactly that way: the sweeper closes people on a timer, and
   * anyone it misses stays `checked_in` forever. So the number an organiser
   * watches live, and the number a fire officer is quoted, drifted upward
   * across a multi-day event and never came back down.
   *
   * The comment on `capacityForNow` warns that two implementations of "which
   * day is it" would eventually disagree. There were two: one asked, one did
   * not.
   *
   * Falls back to event-wide when no occurrence resolves — a single-day event
   * has one occurrence and the scope is identical, and an event between days
   * should report what is in the building rather than zero.
   */
  const slot = await resolveOccurrence(eventId)

  /*
   * Two stores, one line between them, and it is worth stating because the
   * cutover is only half of a migration otherwise.
   *
   * `presence_sessions` answers **who is here now**. It is the only store that
   * can: a session closes, so a room empties, where a mutable `status` on one
   * row per person only ever went up and stayed there whenever the sweeper
   * missed somebody.
   *
   * `event_check_ins` still answers **who came at all**, which is a different
   * question with a different shape — one row per person per occurrence, which
   * is exactly right for attendance and exactly wrong for occupancy.
   *
   * Anything that says "now" reads sessions. Anything that says "ever" reads
   * check-ins. A number that mixes them is the bug this model exists to remove.
   */
  const [event, live, uniqueGuests] = await Promise.all([
    db.events.findUnique({
      where: { id: eventId },
      select: { max_capacity: true },
    }),
    headcount(slot.occurrence ? { occurrenceId: slot.occurrence.id } : { eventId }),
    db.event_check_ins.findMany({
      where: { event_id: eventId, kind: "attendee", check_in_time: { not: null } },
      distinct: ["user_id"],
      select: { user_id: true },
    }),
  ])

  return occupancyFrom({
    // Staff included: `occupancyFrom` subtracts them for the fill figure, and
    // fire safety counts bodies.
    inside: live.insideGuests + live.insideStaff,
    staffInside: live.insideStaff,
    /*
     * Deliberately NOT scoped to today. "Inside" is a question about right now;
     * "how many people has this event drawn" is a question about the whole run,
     * and scoping this one would make a three-day event forget its first two
     * days every morning.
     */
    uniqueAttendance: uniqueGuests.length,
    capacity: capacityForNow(slot, event?.max_capacity ?? null),
  })
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

  /*
   * COUNT(DISTINCT user_id), not a row count.
   *
   * The old query grouped `event_check_ins` rows, which was accidentally right
   * only because one person had one row per occurrence. Sessions give a person
   * several rows on purpose, so grouping rows here would count somebody who
   * stepped out for a cigarette twice — the row-versus-person error arriving in
   * the table built to remove it.
   */
  const rows = await db.$queryRaw<
    { event_id: string; kind: string; people: bigint }[]
  >`
    SELECT event_id, kind, COUNT(DISTINCT user_id) AS people
      FROM presence_sessions
     WHERE event_id = ANY(${eventIds}::uuid[])
       AND departed_at IS NULL
       AND last_seen_at > ${cutoffFrom()}
  GROUP BY event_id, kind
  `

  for (const id of eventIds) out.set(id, { inside: 0, guestsInside: 0 })
  for (const row of rows) {
    const entry = out.get(row.event_id)
    if (!entry) continue
    const n = Number(row.people)
    entry.inside += n
    if (row.kind === "attendee") entry.guestsInside += n
  }
  return out
}
