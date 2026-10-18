import type { Prisma } from "@prisma/client"

import { db } from "./db"
import { getBoundingBox } from "./geo"

/**
 * The most venues a distance sort will pull into memory at once.
 *
 * Same shape and the same reasoning as `DISTANCE_SORT_CEILING` in the events
 * route: this bounds what gets *sorted*, not what gets returned, and it is
 * sized to be unreachable and to say so in the log if it ever is not.
 */
export const DISTANCE_SORT_CEILING = 5000

/** Box half-widths tried, widest first, when a city has more venues than the ceiling. */
const BOX_LADDER_KM = [200, 100, 50, 25, 12, 6, 3, 1.5]

export type DistanceCandidate = { id: string; latitude: number | null; longitude: number | null }

/**
 * The venues a distance sort ranks.
 *
 * Fetched by name, which is fine while they all fit under the ceiling: every
 * one is ranked and the order of the fetch does not matter. Past it, a fetch by
 * name drops whichever venues sort late, near or far, so "nearest first" lost
 * its nearest to the alphabet.
 *
 * Past the ceiling, ascending, this narrows to a box around the caller: the
 * widest on the ladder that holds fewer venues than the ceiling. Everything
 * inside that box is ranked, and anything outside it is farther than the box's
 * half-width, so the nearest venues within it are the true nearest. Venues
 * with no coordinates fall out of a box, which is where they sort anyway.
 * Descending ("farthest first") keeps the name-ordered fetch: a box around the
 * caller would hold exactly the wrong ones.
 *
 * ponytail: a clustered city can leave a box with fewer venues than the page
 * asks for, and the list then ends early (and `warn`s, as at the ceiling). Add
 * a finer ladder or a raw `ORDER BY` distance if that is ever seen.
 */
export async function distanceCandidates(
  where: Prisma.venuesWhereInput,
  lat: number,
  lon: number,
  ascending: boolean,
  ceiling: number = DISTANCE_SORT_CEILING
): Promise<{ rows: DistanceCandidate[]; truncated: boolean }> {
  const read = (w: Prisma.venuesWhereInput) =>
    db.venues.findMany({
      where: w,
      select: { id: true, latitude: true, longitude: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: ceiling,
    })

  const all = await read(where)
  if (all.length < ceiling) return { rows: all, truncated: false }
  if (!ascending) return { rows: all, truncated: true }

  let boxed = all
  for (const km of BOX_LADDER_KM) {
    const box = getBoundingBox(lat, lon, km)
    boxed = await read({
      AND: [where, { latitude: { gte: box.minLat, lte: box.maxLat }, longitude: { gte: box.minLon, lte: box.maxLon } }],
    })
    if (boxed.length < ceiling) return { rows: boxed, truncated: false }
  }
  return { rows: boxed, truncated: true }
}
