/*
 * SCRUM-1447: a row is evidence of another market only when its pin is inside
 * the catalogued city its label names. A "Toronto" label on a Bengaluru pin, or
 * on no pin, says nothing (India by default, as an uncatalogued city does), so
 * relabelling a listing never stops an Indian organisation from buying or opens
 * its Analytics. The itest (`integration/plan-market.itest.ts`) runs the same
 * rule against the migration's catalogue rows.
 */
const mockEvents = jest.fn()
const mockVenues = jest.fn()
jest.mock("@/lib/db", () => ({
  db: {
    events: { findMany: (args: unknown) => mockEvents(args) },
    venues: { findMany: (args: unknown) => mockVenues(args) },
  },
}))
jest.mock("@/lib/cities", () => {
  const actual = jest.requireActual("@/lib/cities") as typeof import("@/lib/cities")
  return { ...actual, cityCatalogue: async () => mockCatalogue }
})

import { buildCatalogue, type CityRow } from "@/lib/cities"
import { marketOf, mayBuyHere } from "@/lib/plan-market"

const city = (row: Partial<CityRow> & Pick<CityRow, "market_code" | "slug" | "name">): CityRow => ({
  id: row.slug,
  match_names: [],
  timezone: "UTC",
  launch_state: "live",
  is_default: false,
  centre_lat: 0,
  centre_lon: 0,
  min_lat: 0,
  min_lon: 0,
  max_lat: 0,
  max_lon: 0,
  sort: 0,
  ...row,
})

// The migration's boxes (20261101160000_markets_and_cities).
const mockCatalogue = buildCatalogue(
  [
    { code: "IN", name: "India", launch_state: "live", sort: 0 },
    { code: "CA", name: "Canada", launch_state: "preview", sort: 1 },
  ],
  [
    city({ market_code: "IN", slug: "bengaluru", name: "Bengaluru", match_names: ["bangalore"], centre_lat: 12.9716, centre_lon: 77.5946, min_lat: 12.83, min_lon: 77.45, max_lat: 13.14, max_lon: 77.78 }),
    city({ market_code: "CA", slug: "toronto", name: "Toronto", match_names: ["mississauga"], centre_lat: 43.6532, centre_lon: -79.3832, min_lat: 43.58, min_lon: -79.64, max_lat: 43.86, max_lon: -79.11 }),
  ]
)

const BENGALURU_PIN = { latitude: 12.9716, longitude: 77.5946 }
const TORONTO_PIN = { latitude: 43.6431, longitude: -79.4246 }
const NO_PIN = { latitude: null, longitude: null }

beforeEach(() => {
  mockEvents.mockReset().mockResolvedValue([])
  mockVenues.mockReset().mockResolvedValue([])
})

describe("marketOf: a row's market is its catalogued city's, only when the pin is inside that city", () => {
  it.each([
    ["Toronto on a Toronto pin", { city: "Toronto", ...TORONTO_PIN }, "CA"],
    ["a name the catalogue folds to Toronto, on a Toronto pin", { city: "mississauga", ...TORONTO_PIN }, "CA"],
    ["Bengaluru on a Bengaluru pin", { city: "Bengaluru", ...BENGALURU_PIN }, "IN"],
    ["Toronto on a Bengaluru pin says nothing", { city: "Toronto", ...BENGALURU_PIN }, null],
    ["Toronto with no pin says nothing", { city: "Toronto", ...NO_PIN }, null],
    ["Toronto with half a pin says nothing", { city: "Toronto", latitude: 43.6431, longitude: null }, null],
    ["an uncatalogued name on a Toronto pin says nothing", { city: "Toronto Downtown", ...TORONTO_PIN }, null],
    ["no city says nothing", { city: null, ...TORONTO_PIN }, null],
    ["on the box's edge is inside", { city: "Toronto", latitude: 43.58, longitude: -79.64 }, "CA"],
  ])("%s", (_label, row, expected) => {
    expect(marketOf(mockCatalogue, row)).toBe(expected)
  })
})

describe("mayBuyHere: a label alone never takes an Indian organisation out of India", () => {
  it("a published-then-cancelled event labelled Toronto on a Bengaluru pin: may still buy", async () => {
    mockEvents.mockResolvedValue([{ city: "Bengaluru", ...BENGALURU_PIN }, { city: "Toronto", ...BENGALURU_PIN }])
    expect(await mayBuyHere("org")).toBe(true)
  })

  it("an owned venue relabelled Toronto on its Bengaluru pin: may still buy", async () => {
    mockVenues.mockResolvedValue([{ city: "Toronto", ...BENGALURU_PIN }])
    expect(await mayBuyHere("org")).toBe(true)
  })

  it("a Toronto label with no pin says nothing", async () => {
    mockEvents.mockResolvedValue([{ city: "Toronto", ...NO_PIN }])
    expect(await mayBuyHere("org")).toBe(true)
  })

  it("a real Toronto pin is still not sold here, for an event and for a venue", async () => {
    mockEvents.mockResolvedValue([{ city: "Toronto", ...TORONTO_PIN }])
    expect(await mayBuyHere("org")).toBe(false)
    mockEvents.mockResolvedValue([])
    mockVenues.mockResolvedValue([{ city: "Toronto", ...TORONTO_PIN }])
    expect(await mayBuyHere("org")).toBe(false)
  })

  it("reads each row's pin with its city", async () => {
    await mayBuyHere("org")
    for (const query of [mockEvents, mockVenues]) {
      expect(query.mock.calls[0][0]).toMatchObject({ select: { city: true, latitude: true, longitude: true } })
    }
  })
})
