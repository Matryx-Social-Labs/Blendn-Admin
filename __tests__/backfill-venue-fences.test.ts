jest.mock("@/lib/db", () => ({ db: {}, closeDb: jest.fn() }))

import { fenceFromCandidates, readExclude, type Candidate } from "../scripts/backfill-venue-fences"
import { DEFAULT_BUFFER_M, GEOFENCE_LIMITS, pointInPolygon, validateGeofence } from "@/lib/geofence"

/*
 * SCRUM-1150 (04a). A seeded, unclaimed venue's check-in area becomes the Overture building its pin is in,
 * by `pickBuilding`'s rule, and only when the ring is one the editor itself would save.
 *
 * GeoJSON is [lng, lat]; a fence ring is [lat, lng]. Fixtures are in Bengaluru, written in the real order.
 */
const pin = { lat: 12.97886, lng: 77.5995 }
const M_PER_DEG_LAT = 111_320
const mLng = M_PER_DEG_LAT * Math.cos((pin.lat * Math.PI) / 180)

/** A closed GeoJSON square, half-side `half` metres, centred `east`/`north` metres from the pin. */
function square(half: number, east = 0, north = 0): number[][] {
  const x = pin.lng + east / mLng
  const y = pin.lat + north / M_PER_DEG_LAT
  const dx = half / mLng
  const dy = half / M_PER_DEG_LAT
  return [[x - dx, y - dy], [x + dx, y - dy], [x + dx, y + dy], [x - dx, y + dy], [x - dx, y - dy]]
}

const building = (id: string, ring: number[][], cls: string | null = null, dataset = "OpenStreetMap"): Candidate => ({
  building: id,
  dataset,
  cls,
  geometry: { type: "Polygon", coordinates: [ring] },
})

describe("fenceFromCandidates — pickBuilding's rule over Overture buildings", () => {
  it("gives the building the pin is in, as a polygon fence with the default buffer that validateGeofence accepts", () => {
    const pick = fenceFromCandidates(pin, "cafe", [building("b1", square(10))])
    expect(pick).toMatchObject({ ok: true, building: "b1", dataset: "OpenStreetMap", how: "contained" })
    if (!pick.ok) throw new Error("no pick")
    expect(pick.fence.type).toBe("polygon")
    expect(pick.fence.buffer).toBe(DEFAULT_BUFFER_M)
    expect(validateGeofence(pick.fence)).toEqual({ ok: true, fence: pick.fence })
    if (pick.fence.type !== "polygon") throw new Error("not a polygon")
    expect(pointInPolygon(pin, pick.fence.ring)).toBe(true)
  })

  it("takes the smallest containing building, not the block around it", () => {
    const pick = fenceFromCandidates(pin, "pub_bar", [building("block", square(40)), building("unit", square(8))])
    expect(pick).toMatchObject({ ok: true, building: "unit", how: "contained" })
  })

  it("lets a stadium win over a smaller building inside it", () => {
    const pick = fenceFromCandidates(pin, "stadium", [
      building("stand", square(15)),
      building("ground", square(120), "stadium"),
    ])
    expect(pick).toMatchObject({ ok: true, building: "ground", how: "contained" })
  })

  it("takes the nearest building within 25 m when none contains the pin", () => {
    const pick = fenceFromCandidates(pin, "restaurant", [
      building("far", square(5, 0, 23)), // edge 18 m north
      building("near", square(5, 12)), // edge 7 m east
    ])
    expect(pick).toMatchObject({ ok: true, building: "near", how: "nearest" })
  })

  it("finds nothing past 25 m: the venue keeps its circle", () => {
    expect(fenceFromCandidates(pin, "cafe", [building("b", square(5, 35))])).toEqual({ ok: false, reason: "none" })
    expect(fenceFromCandidates(pin, "cafe", [])).toEqual({ ok: false, reason: "none" })
  })

  it("reduces a MultiPolygon to its largest part, outer ring only", () => {
    const hole = square(3)
    const pick = fenceFromCandidates(pin, "cafe", [
      {
        building: "multi",
        dataset: "Microsoft ML Buildings",
        cls: null,
        geometry: { type: "MultiPolygon", coordinates: [[square(4, 60)], [square(12), hole]] },
      },
    ])
    expect(pick).toMatchObject({ ok: true, building: "multi", dataset: "Microsoft ML Buildings" })
    if (!pick.ok || pick.fence.type !== "polygon") throw new Error("no polygon")
    expect(pick.fence.ring).toHaveLength(4)
    expect(pointInPolygon(pin, pick.fence.ring)).toBe(true)
  })

  it("refuses a self-intersecting ring rather than store a fence the editor would reject", () => {
    const [a, b, c, d] = square(10)
    const bowTie = [a, c, b, d, a]
    expect(fenceFromCandidates(pin, "cafe", [building("bow", bowTie)])).toEqual({ ok: false, reason: "unusable_ring" })
  })

  it(`simplifies a ring over ${GEOFENCE_LIMITS.MAX_RING} points to one validateGeofence accepts`, () => {
    const n = 400
    const circle = Array.from({ length: n + 1 }, (_, i) => {
      const t = (2 * Math.PI * (i % n)) / n
      return [pin.lng + (15 * Math.cos(t)) / mLng, pin.lat + (15 * Math.sin(t)) / M_PER_DEG_LAT]
    })
    const pick = fenceFromCandidates(pin, "cafe", [building("round", circle)])
    expect(pick).toMatchObject({ ok: true, building: "round" })
    if (!pick.ok || pick.fence.type !== "polygon") throw new Error("no polygon")
    expect(pick.fence.ring.length).toBeLessThanOrEqual(GEOFENCE_LIMITS.MAX_RING)
    expect(validateGeofence(pick.fence).ok).toBe(true)
  })

  it.each(["cafe", "pub_bar", "brewery", "lounge_rooftop", "nightclub", "restaurant", "live_music_venue"] as const)(
    "refuses a building over 20,000 m² for a %s: the mall, not the café in it",
    (type) => {
      // 150 m square = 22,500 m²
      expect(fenceFromCandidates(pin, type, [building("mall", square(75))])).toEqual({
        ok: false,
        reason: "too_big_for_type",
      })
    }
  )

  it("keeps that size for a type that is that big, and a just-under-limit café building", () => {
    expect(fenceFromCandidates(pin, "convention_centre", [building("hall", square(75))])).toMatchObject({ ok: true })
    expect(fenceFromCandidates(pin, null, [building("hall", square(75))])).toMatchObject({ ok: true })
    // 140 m square = 19,600 m²
    expect(fenceFromCandidates(pin, "cafe", [building("big", square(70))])).toMatchObject({ ok: true })
  })
})

describe("readExclude", () => {
  it("takes every --exclude, comma lists included, lower-cased", () => {
    const a = "0FBAA05A-2D36-45FC-8066-82742636044C"
    const b = "11111111-2222-3333-4444-555555555555"
    expect([...readExclude(["--apply", "--exclude", `${a},${b}`, "--exclude", b])].sort()).toEqual(
      [a.toLowerCase(), b].sort()
    )
  })

  it("refuses something that is not a venue id, and a dangling flag", () => {
    expect(() => readExclude(["--exclude", "pilot"])).toThrow(/not a venue id/)
    expect(() => readExclude(["--exclude"])).toThrow(/not a venue id/)
  })
})
