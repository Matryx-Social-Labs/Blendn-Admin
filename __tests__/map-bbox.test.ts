import { bboxParam, bboxWhere } from "@/lib/map-bbox"
import { anyWithin, openCitiesNearestFirst, NEAR_REACH_KM } from "@/lib/near-signal"
import { buildCatalogue, type CityRow, type MarketRow } from "@/lib/cities"
import { eventQuerySchema } from "@/lib/validations/event"
import { venueQuerySchema } from "@/lib/validations/venue"

/** Backend round 3 (SCRUM-1086): the map's view as a box, and the "nothing near you" reach. */

describe("bboxParam: `bbox=minLon,minLat,maxLon,maxLat`, the order a map reports its bounds in", () => {
  it("parses four numbers into a box", () => {
    expect(bboxParam.parse("77.5,12.9,77.7,13.1")).toEqual({ minLon: 77.5, minLat: 12.9, maxLon: 77.7, maxLat: 13.1 })
  })

  it.each([
    ["three numbers", "77.5,12.9,77.7"],
    ["five numbers", "77.5,12.9,77.7,13.1,1"],
    ["a word", "77.5,north,77.7,13.1"],
    ["an empty part", "77.5,,77.7,13.1"],
    ["a latitude past the pole", "77.5,-91,77.7,13.1"],
    ["a longitude past the antimeridian", "77.5,12.9,181,13.1"],
    ["south above north", "77.5,13.1,77.7,12.9"],
    ["west east of east (a box across the antimeridian)", "179,12.9,-179,13.1"],
  ])("refuses %s", (_label, value) => {
    expect(bboxParam.safeParse(value).success).toBe(false)
  })

  it("is a where fragment on the indexed (latitude, longitude) columns", () => {
    expect(bboxWhere({ minLon: 1, minLat: 2, maxLon: 3, maxLat: 4 })).toEqual({
      latitude: { gte: 2, lte: 4 },
      longitude: { gte: 1, lte: 3 },
    })
  })

  it.each([
    ["events", eventQuerySchema],
    ["venues", venueQuerySchema],
  ] as const)("the %s list takes it, and refuses it beside a radius (two shapes of one question)", (_name, schema) => {
    expect(schema.safeParse({ bbox: "77.5,12.9,77.7,13.1" }).success).toBe(true)
    expect(schema.safeParse({ bbox: "77.5,12.9,77.7,13.1", lat: "12.9", lon: "77.6", radius: "5" }).success).toBe(false)
    // The centre+radius query installed apps send is unchanged.
    expect(schema.safeParse({ lat: "12.9", lon: "77.6", radius: "5" }).success).toBe(true)
  })
})

describe("anyWithin: is anything inside the reach of a fix", () => {
  const fix = { lat: 12.9716, lon: 77.5946 }
  it("is true for a row inside the circle", () => {
    expect(anyWithin([{ latitude: 13.0, longitude: 77.6 }], fix.lat, fix.lon, NEAR_REACH_KM)).toBe(true)
  })
  it("is false for a row in the box's corner but outside the circle", () => {
    // 0.2° north and east is about 31 km: inside a 25 km bounding square's corner, outside its circle.
    expect(anyWithin([{ latitude: 12.9716 + 0.2, longitude: 77.5946 + 0.2 }], fix.lat, fix.lon, NEAR_REACH_KM)).toBe(false)
  })
  it("ignores a row with no coordinates", () => {
    expect(anyWithin([{ latitude: null, longitude: null }], fix.lat, fix.lon, NEAR_REACH_KM)).toBe(false)
  })
})

describe("openCitiesNearestFirst: the cities this viewer may open, nearest centre first, any country", () => {
  const markets: MarketRow[] = [
    { code: "IN", name: "India", launch_state: "live", sort: 0 },
    { code: "CA", name: "Canada", launch_state: "preview", sort: 1 },
    { code: "XX", name: "Hidden", launch_state: "hidden", sort: 2 },
  ]
  const city = (market_code: string, slug: string, lat: number, lon: number, launch_state: CityRow["launch_state"] = "live"): CityRow => ({
    id: slug,
    market_code,
    slug,
    name: slug,
    match_names: [],
    timezone: "UTC",
    launch_state,
    is_default: false,
    centre_lat: lat,
    centre_lon: lon,
    min_lat: lat - 0.1,
    min_lon: lon - 0.1,
    max_lat: lat + 0.1,
    max_lon: lon + 0.1,
    sort: 0,
  })
  const catalogue = buildCatalogue(markets, [
    city("IN", "bengaluru", 12.9716, 77.5946),
    city("IN", "mysuru", 12.2958, 76.6394),
    city("IN", "dormant", 12.6, 77.0, "hidden"),
    city("CA", "toronto", 43.6532, -79.3832),
    city("XX", "nowhere", 12.6, 77.0),
  ])

  it("orders by distance from the fix and drops what the viewer cannot open", () => {
    const got = openCitiesNearestFirst(catalogue, new Set(), 12.4, 76.8)
    expect(got.map((c) => c.city.slug)).toEqual(["mysuru", "bengaluru"])
    expect(got[0].distanceKm).toBeGreaterThan(15)
    expect(got[0].distanceKm).toBeLessThan(25)
  })

  it("opens a preview market to its previewers, and from Toronto that is the nearest", () => {
    const got = openCitiesNearestFirst(catalogue, new Set(["CA"]), 43.7, -79.4)
    expect(got[0].city.slug).toBe("toronto")
    expect(got[0].distanceKm).toBeLessThan(10)
  })
})
