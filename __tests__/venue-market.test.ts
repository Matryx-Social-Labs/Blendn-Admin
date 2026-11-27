/*
 * SCRUM-1448 (task 04a): where Venue Pro cannot be bought for a venue, what it
 * adds to the venue's own insights is open (plan "market": 12 months and the
 * pre-claim totals), with no plan named. The venue's market is its OWN row
 * (`marketOf`: a catalogued city label and a pin inside that city), never its
 * organisation's: one Toronto venue never opens Pro on a Bengaluru venue of the
 * same organisation. Nothing is written. A venue that already holds Venue Pro
 * asks nothing more (no catalogue read). The itest (`venue-plans.itest.ts`)
 * runs the same against the migration's catalogue rows.
 */
const mockVenue = jest.fn()
const mockRaw = jest.fn()
const mockHasEntitlement = jest.fn()
const mockCatalogueRead = jest.fn()
jest.mock("@/lib/db", () => ({
  db: {
    venues: { findUnique: (args: unknown) => mockVenue(args) },
    $queryRaw: (...args: unknown[]) => mockRaw(...args),
  },
}))
jest.mock("@/lib/entitlements", () => ({ hasEntitlement: (...args: unknown[]) => mockHasEntitlement(...args) }))
jest.mock("@/lib/cities", () => {
  const actual = jest.requireActual("@/lib/cities") as typeof import("@/lib/cities")
  return {
    ...actual,
    cityCatalogue: async () => {
      mockCatalogueRead()
      return mockCatalogue
    },
  }
})

import { buildCatalogue, type CityRow } from "@/lib/cities"
import { mayBuyVenueHere } from "@/lib/plan-market"
import { venueInsights } from "@/lib/venue-insights"

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

const mockCatalogue = buildCatalogue(
  [
    { code: "IN", name: "India", launch_state: "live", sort: 0 },
    { code: "CA", name: "Canada", launch_state: "preview", sort: 1 },
  ],
  [
    city({ market_code: "IN", slug: "bengaluru", name: "Bengaluru", centre_lat: 12.9716, centre_lon: 77.5946, min_lat: 12.83, min_lon: 77.45, max_lat: 13.14, max_lon: 77.78 }),
    city({ market_code: "CA", slug: "toronto", name: "Toronto", centre_lat: 43.6532, centre_lon: -79.3832, min_lat: 43.58, min_lon: -79.64, max_lat: 43.86, max_lon: -79.11 }),
  ]
)

const TORONTO = { city: "Toronto", latitude: 43.6431, longitude: -79.4246 }
const BENGALURU = { city: "Bengaluru", latitude: 12.9716, longitude: 77.5946 }
const NOW = new Date("2026-11-27T12:00:00Z")
let n = 0

/** A claimed venue with its own id each time, so the insights cache never answers for another case. */
function venueAt(place: { city: string | null; latitude: number | null; longitude: number | null }) {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
  mockVenue.mockResolvedValue({ id, timezone: "UTC", day_reset_hour: 6, claimed_at: new Date("2026-08-01T00:00:00Z"), owner_org_id: "org", ...place })
  return id
}

beforeEach(() => {
  mockVenue.mockReset()
  mockRaw.mockReset().mockResolvedValue([])
  mockHasEntitlement.mockReset().mockResolvedValue(false)
  mockCatalogueRead.mockReset()
})

describe("mayBuyVenueHere: the venue's own row, label and pin together", () => {
  it.each([
    ["a Toronto venue on a Toronto pin", TORONTO, false],
    ["a Bengaluru venue", BENGALURU, true],
    ["a venue relabelled Toronto on its Bengaluru pin", { ...BENGALURU, city: "Toronto" }, true],
    ["a venue with no city", { city: null, latitude: null, longitude: null }, true],
  ])("%s", async (_label, row, expected) => {
    expect(await mayBuyVenueHere(row)).toBe(expected)
  })
})

describe("venueInsights where Venue Pro is not sold", () => {
  it("a Toronto venue without Venue Pro reads its 12 months and its pre-claim totals, plan market", async () => {
    const id = venueAt(TORONTO)
    const view = await venueInsights(id, NOW)
    expect(view).toMatchObject({ plan: "market", recent: { window: "12m" } })
    expect(view!.preClaim).not.toBeNull()
    // Two reads: the year (grid and headline in one) and the pre-claim totals.
    expect(mockRaw).toHaveBeenCalledTimes(2)
  })

  it("a Bengaluru venue without Venue Pro is unchanged: 30 days, nothing paid computed", async () => {
    const id = venueAt(BENGALURU)
    expect(await venueInsights(id, NOW)).toMatchObject({ plan: "listed", recent: { window: "30d" }, preClaim: null })
    expect(mockRaw).toHaveBeenCalledTimes(1)
  })

  it("a venue relabelled Toronto on its Bengaluru pin is not opened", async () => {
    const id = venueAt({ ...BENGALURU, city: "Toronto" })
    expect(await venueInsights(id, NOW)).toMatchObject({ plan: "listed", preClaim: null })
  })

  it("moved to Bengaluru, the same venue reads the ordinary rule at once", async () => {
    const id = venueAt(TORONTO)
    expect((await venueInsights(id, NOW))!.plan).toBe("market")
    mockVenue.mockResolvedValue({ ...(await mockVenue.mock.results[0].value), ...BENGALURU })
    expect(await venueInsights(id, NOW)).toMatchObject({ plan: "listed", preClaim: null })
  })

  it("a venue that holds Venue Pro reads as Pro and asks no market question", async () => {
    mockHasEntitlement.mockResolvedValue(true)
    const id = venueAt(TORONTO)
    expect(await venueInsights(id, NOW)).toMatchObject({ plan: "pro", recent: { window: "12m" } })
    expect(mockCatalogueRead).not.toHaveBeenCalled()
  })

  it("reads the venue's city and pin with its clock", async () => {
    const id = venueAt(TORONTO)
    await venueInsights(id, NOW)
    expect(mockVenue.mock.calls[0][0]).toMatchObject({ select: { city: true, latitude: true, longitude: true } })
  })
})
