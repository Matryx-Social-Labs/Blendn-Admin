import {
  GEOFENCE_LIMITS,
  distanceToGeofence,
  pointInPolygon,
  ringSelfIntersects,
  type LatLng,
} from "./geofence"

/**
 * A venue's outline from OpenStreetMap, for free.
 *
 * Two sources, because OSM records places two ways (measured 2026-09-27):
 *
 *  - **as an area** — a stadium, a palace, a park. Nominatim, which the form
 *    already calls through `/api/geocode`, returns the area's own outline with
 *    `polygon_geojson`. Chinnaswamy Stadium: 31 points; Bangalore Palace: 35.
 *  - **as a pin** — a bar, a club, a restaurant: Toit, The Humming Tree,
 *    Church Street Social. The outline is the building the pin sits in, which
 *    only Overpass can say (`/api/footprint`), and in Indian OSM that building
 *    is often missing — so a caller must always have a fallback.
 *
 * Pure: no network. Both routes and the tests use these.
 */

/** A pin on the pavement still belongs to the building this close to it. */
export const OUTLINE_BUILDING_WITHIN_M = 25

/** Who OSM's servers see. Their usage policies require an identifying agent. */
export const OSM_USER_AGENT = "blendn-admin (https://blendn.app; ops@blendn.app)"

type Ring = [number, number][]

/** GeoJSON positions ([lng, lat], closed) as our ring ([lat, lng], open). */
function toRing(positions: unknown): Ring | null {
  if (!Array.isArray(positions)) return null
  const ring: Ring = []
  for (const p of positions) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number") return null
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
    ring.push([p[1], p[0]])
  }
  const [first, last] = [ring[0], ring[ring.length - 1]]
  if (ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring.pop()
  return ring
}

/**
 * At most MAX_RING corners, or null when it is not a usable shape.
 * ponytail: even sampling, not Visvalingam — Nominatim's `polygon_threshold`
 * has already simplified; this only guards the cap on the rare huge area.
 */
function usable(ring: Ring | null): Ring | null {
  if (!ring) return null
  const max = GEOFENCE_LIMITS.MAX_RING
  const thinned =
    ring.length <= max ? ring : Array.from({ length: max }, (_, i) => ring[Math.floor((i * ring.length) / max)])
  if (thinned.length < GEOFENCE_LIMITS.MIN_RING) return null
  return ringSelfIntersects(thinned) ? null : thinned
}

/** Shoelace, in square degrees — only ever compared, never shown. */
function size(ring: Ring): number {
  let twice = 0
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % ring.length]]
    twice += a[1] * b[0] - b[1] * a[0]
  }
  return Math.abs(twice) / 2
}

/**
 * The outline in a geocoder hit's `geojson`, or null for a pin.
 *
 * A MultiPolygon gives its largest part: the stadium, not its ticket kiosk.
 */
export function outlineFromGeoJson(geojson: unknown): Ring | null {
  if (!geojson || typeof geojson !== "object") return null
  const { type, coordinates } = geojson as { type?: unknown; coordinates?: unknown }
  const polygons =
    type === "Polygon" ? [coordinates] : type === "MultiPolygon" && Array.isArray(coordinates) ? coordinates : []
  const rings = polygons
    .map((polygon) => (Array.isArray(polygon) ? toRing(polygon[0]) : null))
    .filter((ring): ring is Ring => ring !== null && ring.length >= GEOFENCE_LIMITS.MIN_RING)
  const largest = rings.sort((a, b) => size(b) - size(a))[0]
  return usable(largest ?? null)
}

/**
 * The building a pinned place sits in, from Overpass `out geom` elements.
 *
 * A stadium the pin is inside — its outline, not a stand within it, which is
 * what the browser lookup this replaced chose too. Else the smallest building
 * containing the pin (a unit, not the mall around it), else the nearest within
 * OUTLINE_BUILDING_WITHIN_M, else null.
 */
export function pickBuilding(elements: unknown, pin: LatLng): Ring | null {
  if (!Array.isArray(elements)) return null
  const shapes = elements.flatMap((e) => {
    const { type, geometry, tags } = (e ?? {}) as { type?: unknown; geometry?: unknown; tags?: Record<string, unknown> }
    if (type !== "way" || !Array.isArray(geometry)) return []
    const ring = usable(toRing(geometry.map((g: { lat?: unknown; lon?: unknown }) => [g?.lon, g?.lat])))
    return ring ? [{ ring, stadium: tags?.leisure === "stadium" }] : []
  })

  const containing = shapes
    .filter(({ ring }) => pointInPolygon(pin, ring))
    .sort((a, b) => Number(b.stadium) - Number(a.stadium) || size(a.ring) - size(b.ring))
  if (containing.length) return containing[0].ring

  const near = shapes
    .filter(({ stadium }) => !stadium)
    .map(({ ring }) => ({ ring, metres: distanceToGeofence(pin, { type: "polygon", ring, buffer: 0 }) }))
    .filter(({ metres }) => metres <= OUTLINE_BUILDING_WITHIN_M)
    .sort((a, b) => a.metres - b.metres)
  return near[0]?.ring ?? null
}
