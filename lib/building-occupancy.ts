import { db } from "@/lib/db"
import { LIVE_COUNT_BUCKETS, liveCountBucket, type LiveCountBucket } from "@/lib/disclosure"
import { claimedWindow, hostsEvent } from "@/lib/event-visibility"
import { getOccupancies } from "@/lib/occupancy"

/**
 * How many people are in the building.
 *
 * Occupancy is per event, which is the right unit for an organiser and the wrong
 * one for the person who owns the room. A venue running two events at once —
 * the main room and the basement, a wedding upstairs and a club night below —
 * has two correct numbers and no answer to the only question the fire officer
 * asks, which is how many people are inside the building.
 *
 * This was flagged during the check-in work and deferred as "worth having, not
 * scoped here". It is scoped here.
 *
 * ## Bodies, not guests
 *
 * The total counts staff, for the same reason per-event occupancy does: a fire
 * safety number counts bodies rather than job titles. The per-event breakdown
 * keeps the split so an owner can still see which of the two rooms is full of
 * whom.
 *
 * ## Against the venue's capacity, not the sum of the events'
 *
 * Two events in one building can each be under their own stated capacity while
 * the building is over its own. `venues.capacity` is the number the building is
 * licensed for; adding up the event capacities would answer a different and
 * less important question.
 */

export interface RoomOccupancy {
  eventId: string
  title: string
  /** The venue's own live room (a venue day) rather than a host's night. */
  venueDay: boolean
  /** A range when the owner reads a room another host runs (SCRUM-516). */
  inside: number | LiveCountBucket
  /** Null beside a range: the split is two more counts. */
  guestsInside: number | null
  staffInside: number | null
}

export interface BuildingOccupancy {
  /**
   * Everyone inside the building right now, across every live event. Null when
   * a room is a range and there are others: total minus the rooms shown exactly
   * would be the ranged room's count.
   */
  inside: number | LiveCountBucket | null
  /** The venue's licensed capacity, or null when none is stated. */
  capacity: number | null
  /** Null when the venue states no capacity. Uncapped, like the event one. */
  fillPct: number | null
  overCapacity: boolean
  /** One entry per event running now, busiest first. */
  rooms: RoomOccupancy[]
}

export async function getBuildingOccupancy(
  venueId: string,
  opts: {
    now?: Date
    /**
     * The venue's owner, not an admin: only rooms that opened at or after the
     * claim. A night that began before it is not theirs to see, even while it
     * runs (SCRUM-355, SCRUM-500); with no claim date, no rooms at all. And a
     * room their organisation does not run reads as a range (SCRUM-516).
     */
    asOwner?: { id: string; orgIds: readonly string[] } | null
  } = {}
): Promise<BuildingOccupancy> {
  const now = opts.now ?? new Date()
  const venue = await db.venues.findUnique({
    where: { id: venueId },
    select: { capacity: true, claimed_at: true },
  })
  const window = opts.asOwner && venue ? claimedWindow(venue) : undefined
  const live =
    window === null
      ? []
      : await db.events.findMany({
          where: {
            venue_id: venueId,
            deleted_at: null,
            /*
             * any-kind: hosts' nights AND the venue's own live room (step 17).
             * People live at the venue are in the building too, and the fire
             * officer counts them. Nobody runs a venue day (its
             * organizer_org_id is null), so for the owner its count is a range
             * like every room they do not run; an admin reads it exactly.
             */
            status: "published",
            // Running right now. An event that ended an hour ago has people in
            // its check-in table and nobody in the building.
            start_time: { lte: now, ...(window ? { gte: window.gte } : {}) },
            end_time: { gte: now },
          },
          select: { id: true, title: true, kind: true, organizer_id: true, organizer_org_id: true },
        })

  const capacity = venue?.capacity ?? null
  if (live.length === 0) {
    return { inside: 0, capacity, fillPct: capacity ? 0 : null, overCapacity: false, rooms: [] }
  }

  // One grouped query for every room rather than one per event — a venue with
  // four concurrent rooms should not cost four round trips.
  const occupancies = await getOccupancies(live.map((e) => e.id))

  const owner = opts.asOwner
  const counted = live.map((event) => ({
    event,
    ...(occupancies.get(event.id) ?? { inside: 0, guestsInside: 0 }),
    ranged: owner ? !hostsEvent(owner, event) : false,
  }))
  const anyRanged = counted.some((r) => r.ranged)
  const inside = counted.reduce((sum, r) => sum + r.inside, 0)

  const rooms: RoomOccupancy[] = counted
    /*
     * Busiest first -- by what is shown. Ordered by the exact counts, two
     * rooms both reading "Under 5" would swap places as one person walks in.
     */
    .sort((a, b) => {
      const rank = (n: number) => (anyRanged ? LIVE_COUNT_BUCKETS.indexOf(liveCountBucket(n)) : n)
      return rank(b.inside) - rank(a.inside) || a.event.title.localeCompare(b.event.title)
    })
    .map((r) => ({
      eventId: r.event.id,
      // A venue day's own title is "Venue day · <name> · <date>": the room,
      // said plainly, and the internal name never sent to a page.
      title: r.event.kind === "venue_day" ? "Live at the venue" : r.event.title,
      venueDay: r.event.kind === "venue_day",
      ...(r.ranged
        ? { inside: liveCountBucket(r.inside), guestsInside: null, staffInside: null }
        : { inside: r.inside, guestsInside: r.guestsInside, staffInside: r.inside - r.guestsInside }),
    }))

  return {
    inside: !anyRanged ? inside : rooms.length === 1 ? rooms[0].inside : null,
    capacity,
    // Uncapped, like the event figure: a building over its licence is the thing
    // worth seeing, and clamping to 100 makes it unrepresentable. None beside a
    // range: a percentage of the licence is the count again.
    fillPct: anyRanged || capacity === null || capacity <= 0 ? null : Math.round((inside / capacity) * 100),
    // On the exact total whatever is shown: the licence is the owner's to keep.
    overCapacity: capacity !== null && capacity > 0 && inside > capacity,
    rooms,
  }
}
