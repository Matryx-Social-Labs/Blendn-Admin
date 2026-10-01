import { Prisma, type venue_type } from "@prisma/client"

import { db } from "@/lib/db"
import { getBoundingBox, haversineDistanceMeters } from "@/lib/geo"
import { DEFAULT_BUFFER_M, distanceToGeofence, validateGeofence, type Geofence } from "@/lib/geofence"
import { defaultExtentMetres } from "@/lib/venue-types"

/**
 * The rules a new venue is held to, wherever it comes from.
 *
 * Out of `lib/venue-actions.ts` because that file is `"use server"`: every
 * export there is a callable endpoint, and `nearbyVenues` takes an `isAdmin`
 * flag that must never be a caller's to set. `createVenue` (the dashboard) and
 * `scripts/import-venues.ts` (founder seeding) both read these, so a seeded
 * venue meets the same duplicate check and gets the same default area as one
 * typed into the form.
 */

/** Two records for one building is how "The Loft" and "the loft" both exist. */
export const DUPLICATE_RADIUS_M = 100
/**
 * How far to look for a venue whose outline could hold the new pin. A pin
 * inside a stadium can be 130 m from the stadium's own pin — past the 100 m
 * rule — so outlines are searched wider and judged by the shape itself.
 * ponytail: a fixed 2 km box; widen it if a venue's outline ever spans more.
 */
const OUTLINE_SEARCH_M = 2000

/** A row of the duplicate check's lookup — `venuesNear`'s raw query. */
interface NearbyRow {
  id: string
  name: string
  address: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  owner_org_id: string | null
  geofence: unknown
  owner_name: string | null
}

export interface NearbyVenue {
  id: string
  name: string
  address: string | null
  city: string | null
  distanceMetres: number
  claimed: boolean
  /** Only shown to admins — otherwise it enumerates who owns what. */
  ownerName: string | null
}

/**
 * The venues a new pin would duplicate: within 100 m of their pin, or inside
 * their outline (SCRUM-352). Nearest first. Not rate limited here; callers
 * that face a person limit themselves (`venuesNear`, `createVenue`).
 */
export async function nearbyVenues(lat: number, lng: number, isAdmin: boolean): Promise<NearbyVenue[]> {
  // Bounding boxes first so the lat/lng index does the coarse filter, then
  // exact distances in memory. Nearest first *before* the LIMIT: a busy
  // district would otherwise hand back whichever rows the scan met first and
  // drop the real neighbour (#database-review, SCRUM-352). Two lookups, so the
  // wide one for outlines never crowds a 100 m neighbour out of the tight one.
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const nearest = (metres: number, outlinesOnly: boolean, limit: number) => {
    const box = getBoundingBox(lat, lng, metres / 1000)
    return db.$queryRaw<NearbyRow[]>`
      SELECT v.id, v.name, v.address, v.city, v.latitude, v.longitude, v.owner_org_id, v.geofence,
             o.display_name AS owner_name
        FROM venues v
        LEFT JOIN organisations o ON o.id = v.owner_org_id
       WHERE v.deleted_at IS NULL
         AND v.latitude BETWEEN ${box.minLat} AND ${box.maxLat}
         AND v.longitude BETWEEN ${box.minLon} AND ${box.maxLon}
         ${outlinesOnly ? Prisma.sql`AND v.geofence->>'type' = 'polygon'` : Prisma.empty}
       ORDER BY power(v.latitude - ${lat}, 2) + power((v.longitude - ${lng}) * ${cosLat}, 2)
       LIMIT ${limit}`
  }
  // A pin inside a stadium can be 130 m from the stadium's own pin (SCRUM-352).
  const [near, outlined] = await Promise.all([
    nearest(DUPLICATE_RADIUS_M, false, 50),
    nearest(OUTLINE_SEARCH_M, true, 200),
  ])
  const candidates = [...near, ...outlined.filter((o) => !near.some((n) => n.id === o.id))]

  return candidates
    .flatMap((v) => {
      if (v.latitude === null || v.longitude === null) return []
      const distanceMetres = Math.round(
        haversineDistanceMeters(lat, lng, v.latitude, v.longitude)
      )
      // Near its pin, or inside its outline (SCRUM-352).
      const fence = validateGeofence(v.geofence)
      const insideIt = fence.ok && fence.fence.type === "polygon" && distanceToGeofence({ lat, lng }, fence.fence) === 0
      if (distanceMetres > DUPLICATE_RADIUS_M && !insideIt) return []
      return [
        {
          id: v.id,
          name: v.name,
          address: v.address,
          city: v.city,
          distanceMetres,
          claimed: v.owner_org_id !== null,
          // A host learning which company owns which venue is a customer list.
          ownerName: isAdmin ? v.owner_name : null,
        },
      ]
    })
    .sort((a, b) => a.distanceMetres - b.distanceMetres)
}

/**
 * The area a venue gets when nobody drew one: a circle sized for its type
 * (`defaultExtentMetres`), plus the default buffer. A café and a stadium are
 * not one size.
 */
export function defaultVenueFence(lat: number, lng: number, venueType: venue_type | null): Geofence {
  return { type: "circle", lat, lng, radius: defaultExtentMetres(venueType), buffer: DEFAULT_BUFFER_M }
}
