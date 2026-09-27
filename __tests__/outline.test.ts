import { GEOFENCE_LIMITS, pointInPolygon, ringSelfIntersects } from "@/lib/geofence"
import { OUTLINE_BUILDING_WITHIN_M, outlineFromGeoJson, pickBuilding } from "@/lib/outline"

/*
 * SCRUM-351. Typing a venue's address should bring its outline when OSM has
 * one — for free, from the geocoder the form already calls (Nominatim's
 * `polygon_geojson`) or, for a place that is only a pin, from the building it
 * sits in (Overpass). Measured on 2026-09-27: Chinnaswamy Stadium and Bangalore
 * Palace come back as polygons; Toit, The Humming Tree and Church Street Social
 * as points.
 *
 * GeoJSON is [lng, lat]. Our rings are [lat, lng]. A swap puts Bengaluru in
 * the Indian Ocean, so every fixture here is written in the real order.
 */
const lat = 12.97886
const lng = 77.5995

/** A closed GeoJSON square, [lng, lat], first point repeated last. */
const geoSquare = (d: number, cLat = lat, cLng = lng) => [
  [cLng - d, cLat - d],
  [cLng + d, cLat - d],
  [cLng + d, cLat + d],
  [cLng - d, cLat + d],
  [cLng - d, cLat - d],
]

describe("outlineFromGeoJson — the place's own outline, from the geocoder", () => {
  it("turns a Polygon's outer ring into ours: [lat, lng], the closing point dropped", () => {
    const ring = outlineFromGeoJson({ type: "Polygon", coordinates: [geoSquare(0.001)] })
    expect(ring).toHaveLength(4)
    expect(ring![0]).toEqual([lat - 0.001, lng - 0.001])
    expect(pointInPolygon({ lat, lng }, ring!)).toBe(true)
  })

  it("takes the largest part of a MultiPolygon — the stadium, not its ticket kiosk", () => {
    const ring = outlineFromGeoJson({
      type: "MultiPolygon",
      coordinates: [[geoSquare(0.0001, lat + 0.01)], [geoSquare(0.001)]],
    })
    expect(pointInPolygon({ lat, lng }, ring!)).toBe(true)
  })

  it("has no outline for a Point — a bar or a restaurant is a pin in OSM", () => {
    expect(outlineFromGeoJson({ type: "Point", coordinates: [lng, lat] })).toBeNull()
    expect(outlineFromGeoJson(undefined)).toBeNull()
    expect(outlineFromGeoJson({ type: "Polygon", coordinates: "junk" })).toBeNull()
  })

  it("thins an outline longer than MAX_RING, and it stays a shape that holds the place", () => {
    const n = GEOFENCE_LIMITS.MAX_RING * 3
    const circle = Array.from({ length: n + 1 }, (_, i) => {
      const a = (2 * Math.PI * (i % n)) / n
      return [lng + 0.001 * Math.cos(a), lat + 0.001 * Math.sin(a)]
    })
    const ring = outlineFromGeoJson({ type: "Polygon", coordinates: [circle] })!
    expect(ring.length).toBeLessThanOrEqual(GEOFENCE_LIMITS.MAX_RING)
    expect(ring.length).toBeGreaterThanOrEqual(GEOFENCE_LIMITS.MIN_RING)
    expect(ringSelfIntersects(ring)).toBe(false)
    expect(pointInPolygon({ lat, lng }, ring)).toBe(true)
  })

  it("refuses a ring that crosses itself, and one too short to be a shape", () => {
    const bowtie = [[lng, lat], [lng + 0.001, lat + 0.001], [lng + 0.001, lat], [lng, lat + 0.001], [lng, lat]]
    expect(outlineFromGeoJson({ type: "Polygon", coordinates: [bowtie] })).toBeNull()
    expect(outlineFromGeoJson({ type: "Polygon", coordinates: [[[lng, lat], [lng + 0.001, lat], [lng, lat]]] })).toBeNull()
  })
})

describe("pickBuilding — the building a pinned place sits in (Overpass `out geom`)", () => {
  /** An Overpass way with geometry, { lat, lon } per node, closed. */
  const way = (id: number, d: number, cLat: number, cLng: number, name?: string) => ({
    type: "way",
    id,
    tags: { building: "yes", ...(name ? { name } : {}) },
    geometry: geoSquare(d, cLat, cLng).map(([x, y]) => ({ lat: y, lon: x })),
  })

  it("takes the building the pin is inside, over a bigger one next door", () => {
    const inside = way(1, 0.0001, lat, lng, "Toit")
    const bigNeighbour = way(2, 0.001, lat + 0.0025, lng)
    const ring = pickBuilding([bigNeighbour, inside], { lat, lng })
    expect(ring).not.toBeNull()
    expect(pointInPolygon({ lat, lng }, ring!)).toBe(true)
    expect(ring).toHaveLength(4)
  })

  it(`else the nearest building within ${OUTLINE_BUILDING_WITHIN_M} m — a pin dropped on the pavement`, () => {
    const near = way(3, 0.0001, lat + 0.0002, lng) // edge ~11 m north of the pin
    const far = way(4, 0.0001, lat + 0.0008, lng)
    const ring = pickBuilding([far, near], { lat, lng })
    expect(ring).not.toBeNull()
    expect(pointInPolygon({ lat: lat + 0.0002, lng }, ring!)).toBe(true)
  })

  it(`has nothing when every building is further than ${OUTLINE_BUILDING_WITHIN_M} m`, () => {
    expect(pickBuilding([way(5, 0.0001, lat + 0.001, lng)], { lat, lng })).toBeNull()
  })

  it("ignores what is not a closed shape — nodes, and ways too short", () => {
    const stub = { type: "way", id: 6, tags: {}, geometry: [{ lat, lon: lng }, { lat: lat + 0.0001, lon: lng }] }
    expect(pickBuilding([{ type: "node", id: 7, lat, lon: lng }, stub], { lat, lng })).toBeNull()
  })
})
