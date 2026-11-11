import { buildCatalogue, cityToStore, type CityRow, type MarketRow } from "@/lib/cities"

/*
 * SCRUM-1038: "Koramangala" was listed as a city under "Where Blend'n is on", with no country. An event's city is free
 * text, a neighbourhood typed there was stored as is, and an uncatalogued name is a city of its own on every list. The
 * pin says which city it is: a name the catalogue does not know, at a point inside a catalogue city, is that city.
 */

const market: MarketRow = { code: "IN", name: "India", launch_state: "live", sort: 0 }
const city = (over: Partial<CityRow> & Pick<CityRow, "slug" | "name">): CityRow => ({
  id: `id-${over.slug}`,
  market_code: "IN",
  match_names: [],
  timezone: "Asia/Kolkata",
  launch_state: "live",
  is_default: false,
  centre_lat: 0,
  centre_lon: 0,
  min_lat: 0,
  min_lon: 0,
  max_lat: 0,
  max_lon: 0,
  sort: 0,
  ...over,
})

const catalogue = buildCatalogue(
  [market],
  [
    city({ slug: "bengaluru", name: "Bengaluru", match_names: ["bangalore"], centre_lat: 12.97, centre_lon: 77.59, min_lat: 12.8, min_lon: 77.4, max_lat: 13.2, max_lon: 77.8 }),
    // Overlaps Bengaluru's box on its east edge; its centre is further from the overlap than Bengaluru's.
    city({ slug: "hosur", name: "Hosur", centre_lat: 12.74, centre_lon: 77.83, min_lat: 12.6, min_lon: 77.7, max_lat: 12.9, max_lon: 77.95 }),
    city({ slug: "mysuru", name: "Mysuru", launch_state: "hidden", centre_lat: 12.3, centre_lon: 76.64, min_lat: 12.2, min_lon: 76.5, max_lat: 12.4, max_lon: 76.8 }),
  ]
)

describe("cityToStore (SCRUM-1038)", () => {
  it("stores a neighbourhood inside a catalogue city as that city", () => {
    expect(cityToStore(catalogue, "Koramangala", 12.9346, 77.6269)).toBe("Bengaluru")
    expect(cityToStore(catalogue, "  indiranagar ", 12.97, 77.64)).toBe("Bengaluru")
  })

  it("keeps a name the catalogue knows, in the spelling given (control: the pin does not overrule a city)", () => {
    expect(cityToStore(catalogue, "Bangalore", 12.9346, 77.6269)).toBe("Bangalore")
    // Even a pin elsewhere: a known city is never rewritten into another one.
    expect(cityToStore(catalogue, "Mysuru", 12.9346, 77.6269)).toBe("Mysuru")
  })

  it("keeps a name with no catalogue city at its pin: a city we do not serve yet is still a city", () => {
    expect(cityToStore(catalogue, "Pune", 18.52, 73.86)).toBe("Pune")
  })

  it("keeps the name when there is no pin to say otherwise", () => {
    expect(cityToStore(catalogue, "Koramangala", null, null)).toBe("Koramangala")
    expect(cityToStore(catalogue, "Koramangala", undefined, 77.6)).toBe("Koramangala")
  })

  it("passes null and undefined through, so a PATCH that leaves the city alone still does", () => {
    expect(cityToStore(catalogue, null, 12.93, 77.62)).toBeNull()
    expect(cityToStore(catalogue, undefined, 12.93, 77.62)).toBeUndefined()
  })

  it("where two boxes overlap, takes the city whose centre is nearer; a hidden city is still that city", () => {
    expect(cityToStore(catalogue, "Electronic City", 12.88, 77.72)).toBe("Bengaluru")
    expect(cityToStore(catalogue, "Bagalur", 12.75, 77.75)).toBe("Hosur")
    expect(cityToStore(catalogue, "Gokulam", 12.33, 76.63)).toBe("Mysuru")
  })
})
