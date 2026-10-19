import type { Prisma } from "@prisma/client"

import { db } from "./db"
import { getBoundingBox, haversineDistance } from "./geo"

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
/** The part of a box's half-width inside which every venue is certainly ranked. */
const BOX_CERTAIN = 0.99
/** Halvings between two ladder steps when the narrower box holds fewer venues than the page needs. */
const BISECTIONS = 6

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
 * inside that box's inscribed circle is ranked (the corners are farther than
 * the edge, and a venue just outside an edge may be nearer than a corner row),
 * so the nearest venues are the true nearest. The answer says `truncated`.
 * Venues with no coordinates fall out of a box, which is where they sort anyway.
 * Descending ("farthest first") keeps the name-ordered fetch: a box around the
 * caller would hold exactly the wrong ones.
 *
 * ponytail: the box is found by counting, so it is as wide as the ceiling allows
 * but the circle inside it can still hold fewer than `need` rows; the list then
 * ends early (and `warn`s, as at the ceiling). A raw `ORDER BY` distance is the
 * upgrade if that is ever seen.
 */
export async function distanceCandidates(
  where: Prisma.venuesWhereInput,
  lat: number,
  lon: number,
  ascending: boolean,
  /** Rows the page asks for (page x limit): a box that holds fewer is not narrow enough to trust. */
  need: number,
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

  // Count down the ladder (one cheap probe each) and read rows once, at the first box that fits.
  const boxWhere = (km: number): Prisma.venuesWhereInput => {
    const box = getBoundingBox(lat, lon, km)
    return {
      AND: [where, { latitude: { gte: box.minLat, lte: box.maxLat }, longitude: { gte: box.minLon, lte: box.maxLon } }],
    }
  }
  const countIn = (km: number) => db.venues.count({ where: boxWhere(km) })
  let km = BOX_LADDER_KM[BOX_LADDER_KM.length - 1]
  let held = Infinity
  let step = BOX_LADDER_KM.length - 1
  for (const [i, candidate] of BOX_LADDER_KM.entries()) {
    const n = await countIn(candidate)
    if (n < ceiling) {
      ;[km, held, step] = [candidate, n, i]
      break
    }
  }
  /*
   * Never narrow to a box that holds fewer venues than the page needs: the list
   * would end early on a city that has plenty. Between the box that fits and the
   * wider one that does not, bisect for the widest that does.
   */
  if (step > 0 && held < need) {
    let lo = km
    let hi = BOX_LADDER_KM[step - 1]
    for (let i = 0; i < BISECTIONS && held < need; i++) {
      const mid = (lo + hi) / 2
      const n = await countIn(mid)
      if (n < ceiling) [lo, held] = [mid, n]
      else hi = mid
    }
    km = lo
  }
  /*
   * The box is a square: its corners reach 1.41x the half-width, so a venue just
   * outside an edge can be nearer than a corner row. Only the inscribed circle
   * is certain to hold the true nearest, with 1 % to spare for the flat-earth
   * box maths. And a boxed answer is a partial one, so say so.
   */
  const boxed = await read(boxWhere(km))
  const certain = boxed.filter(
    (v) => v.latitude !== null && v.longitude !== null && haversineDistance(lat, lon, v.latitude, v.longitude) <= km * BOX_CERTAIN
  )
  return { rows: certain, truncated: true }
}
