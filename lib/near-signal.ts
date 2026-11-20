import type { Prisma } from "@prisma/client"

import { cityAccess, cityRule, cityRuleWhere } from "./browse-scope"
import { cityCatalogue, previewMarketsFor, type Catalogue, type CatalogueCity } from "./cities"
import { db } from "./db"
import { realEventsWhere } from "./event-kind"
import { getBoundingBox, haversineDistance } from "./geo"
import { bboxWhere } from "./map-bbox"

/**
 * "Nothing near you yet · showing {city}" (pulse-map sheet 07, frames 3–4; backend round 3, SCRUM-1086).
 *
 * For a fix: is anything the viewer could go to within the reach, and when nothing is, the nearest city they may open
 * that has something, and how far its centre is. Country-agnostic: the cities are the catalogue's rows, the distance is
 * the great circle, and the reach is one number for everyone.
 */

/** The board's "Nothing within 25 km yet". */
export const NEAR_REACH_KM = 25
/**
 * How many rows in the reach's bounding square are read to find one inside its circle. A square holding this many
 * with none inside the circle (its corners are 21% of it) does not happen in a real city; past it, "something is near".
 */
const NEAR_SCAN_CAP = 200

export type NearestCity = {
  slug: string
  name: string
  country: string
  distanceKm: number
  centre: { latitude: number; longitude: number }
}

export type NearSignal = { reachKm: number; empty: boolean; nearestCity: NearestCity | null }

type Point = { latitude: number | null; longitude: number | null }

export function anyWithin(rows: readonly Point[], lat: number, lon: number, km: number): boolean {
  return rows.some((r) => r.latitude !== null && r.longitude !== null && haversineDistance(lat, lon, r.latitude, r.longitude) <= km)
}

/** The cities this viewer may open fully, nearest centre first. Pure. */
export function openCitiesNearestFirst(catalogue: Catalogue, previewMarkets: ReadonlySet<string>, lat: number, lon: number) {
  return catalogue.cities
    .filter((city) => cityAccess(city, previewMarkets) === "full")
    .map((city) => ({ city, distanceKm: haversineDistance(lat, lon, city.centre.latitude, city.centre.longitude) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
}

const nearestCityOf = ({ city, distanceKm }: { city: CatalogueCity; distanceKm: number }): NearestCity => ({
  slug: city.slug,
  name: city.name,
  country: city.country,
  distanceKm: Math.round(distanceKm * 10) / 10,
  centre: city.centre,
})

/**
 * `discoverable`: the list's own rules for what a viewer may see (published, public, not ended, real, their age), with
 * no city, search, category or date in it: "nothing near you" is about Blend'n being there, not about a filter.
 */
export async function nearSignal(userId: string, discoverable: Prisma.eventsWhereInput, lat: number, lon: number): Promise<NearSignal> {
  const catalogue = await cityCatalogue()
  const previewMarkets = await previewMarketsFor(userId, catalogue)
  const open = { AND: [discoverable, cityRuleWhere(cityRule(catalogue, undefined, previewMarkets))] }

  const box = getBoundingBox(lat, lon, NEAR_REACH_KM)
  const inSquare = await db.events.findMany({
    where: { ...realEventsWhere, AND: [open, bboxWhere(box)] },
    select: { latitude: true, longitude: true },
    take: NEAR_SCAN_CAP,
  })
  if (inSquare.length === NEAR_SCAN_CAP || anyWithin(inSquare, lat, lon, NEAR_REACH_KM)) {
    return { reachKm: NEAR_REACH_KM, empty: false, nearestCity: null }
  }

  /*
   * Nearest first, one existence read each, until a city has something to show on the map: a live city with no events
   * is not a place to send anyone. Inside the city's box as well as its names, so the read walks the (latitude,
   * longitude) index rather than every row (a city name matches case-insensitively, which no index serves), and what
   * it finds is something the map can draw there. ponytail: one read per open city at worst (the catalogue is a dozen
   * rows); group by city in SQL if it grows to hundreds.
   */
  for (const candidate of openCitiesNearestFirst(catalogue, previewMarkets, lat, lon)) {
    const b = candidate.city.bounds
    const some = await db.events.findFirst({
      where: {
        ...realEventsWhere,
        AND: [
          discoverable,
          cityRuleWhere({ only: candidate.city.matchKeys }),
          bboxWhere({ minLat: b.minLat, minLon: b.minLon, maxLat: b.maxLat, maxLon: b.maxLon }),
        ],
      },
      select: { id: true },
    })
    if (some) return { reachKm: NEAR_REACH_KM, empty: true, nearestCity: nearestCityOf(candidate) }
  }
  return { reachKm: NEAR_REACH_KM, empty: true, nearestCity: null }
}
