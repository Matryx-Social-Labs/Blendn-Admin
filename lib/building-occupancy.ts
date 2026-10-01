import { db } from "@/lib/db"
import { claimedWindow } from "@/lib/event-visibility"
import { getOccupancies } from "@/lib/occupancy"
import { realEventsWhere } from "./event-kind"

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
  inside: number
  guestsInside: number
  staffInside: number
}

export interface BuildingOccupancy {
  /** Everyone inside the building right now, across every live event. */
  inside: number
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
     * runs (SCRUM-355, SCRUM-500); with no claim date, no rooms at all.
     */
    asOwner?: boolean
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
             * Hosts' rooms only, for now. People live at the venue are in the
             * building too, but this panel lists each room with an exact count
             * and a title; a venue day joins it when the owner's screens are
             * redesigned (step 17), with its count through `discloseFigure`.
             */
            ...realEventsWhere,
            status: "published",
            // Running right now. An event that ended an hour ago has people in
            // its check-in table and nobody in the building.
            start_time: { lte: now, ...(window ? { gte: window.gte } : {}) },
            end_time: { gte: now },
          },
          select: { id: true, title: true },
        })

  const capacity = venue?.capacity ?? null
  if (live.length === 0) {
    return { inside: 0, capacity, fillPct: capacity ? 0 : null, overCapacity: false, rooms: [] }
  }

  // One grouped query for every room rather than one per event — a venue with
  // four concurrent rooms should not cost four round trips.
  const occupancies = await getOccupancies(live.map((e) => e.id))

  const rooms: RoomOccupancy[] = live
    .map((event) => {
      const o = occupancies.get(event.id) ?? { inside: 0, guestsInside: 0 }
      return {
        eventId: event.id,
        title: event.title,
        inside: o.inside,
        guestsInside: o.guestsInside,
        staffInside: o.inside - o.guestsInside,
      }
    })
    .sort((a, b) => b.inside - a.inside || a.title.localeCompare(b.title))

  const inside = rooms.reduce((sum, r) => sum + r.inside, 0)

  return {
    inside,
    capacity,
    // Uncapped, like the event figure: a building over its licence is the thing
    // worth seeing, and clamping to 100 makes it unrepresentable.
    fillPct: capacity === null || capacity <= 0 ? null : Math.round((inside / capacity) * 100),
    overCapacity: capacity !== null && capacity > 0 && inside > capacity,
    rooms,
  }
}
