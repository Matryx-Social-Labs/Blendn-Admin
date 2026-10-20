const mockDb = {
  profiles: { findUnique: jest.fn() },
  venues: { groupBy: jest.fn(), findMany: jest.fn() },
  events: { findMany: jest.fn() },
  event_check_ins: { findMany: jest.fn() },
}
const mockAuth = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a) }))

import { NextRequest } from "next/server"

import { GET } from "@/app/api/mobile/venues/summary/route"
import { SUMMARY_AREAS_MAX, summarise } from "@/lib/venue-summary"

/**
 * C5 (home panes): `GET /venues/summary`. The shaping is pure and tested on its
 * own; the route is asserted on what it asks the database, once, over the
 * list's own set of venues.
 */
const g = (venue_type: string | null, area: string | null, n: number) => ({
  venue_type,
  area,
  area_slug: area ? area.toLowerCase().replace(/\W+/g, "-") : null,
  _count: { _all: n },
})

describe("summarise", () => {
  const groups = [
    g("pub_bar", "Indiranagar", 5),
    g("cafe", "Indiranagar", 3),
    g("brewery", "Indiranagar", 2),
    g("nightclub", "Indiranagar", 1),
    g("restaurant", "Indiranagar", 1),
    g("pub_bar", "HSR Layout", 4),
    g("pub_bar", null, 6),
    g(null, null, 2),
  ] as Parameters<typeof summarise>[0]

  it("counts every listed venue in total, the unclassified and the area-less too", () => {
    expect(summarise(groups, new Map(), 0, 0).total).toBe(24)
  })

  it("splits by type, most first, with the app's label and without the unclassified", () => {
    const { types } = summarise(groups, new Map(), 0, 0)
    expect(types[0]).toEqual({ venueType: "pub_bar", label: "Pub or bar", count: 15 })
    expect(types.map((t) => t.venueType)).toEqual(["pub_bar", "cafe", "brewery", "nightclub", "restaurant"])
  })

  it("splits by area: live venues first, then places; the type mix is the four commonest", () => {
    const { areas } = summarise(groups, new Map([["hsr-layout", 1]]), 1, 0)
    expect(areas.map((a) => a.slug)).toEqual(["hsr-layout", "indiranagar"])
    expect(areas[0]).toMatchObject({ name: "HSR Layout", count: 4, liveCount: 1, typeMix: ["pub_bar"] })
    expect(areas[1]).toMatchObject({ count: 12, liveCount: 0, typeMix: ["pub_bar", "cafe", "brewery", "nightclub"] })
  })

  it("puts a venue with no area in no area", () => {
    const { areas } = summarise(groups, new Map(), 0, 0)
    expect(areas.reduce((n, a) => n + a.count, 0)).toBe(16)
  })

  it("passes the live and open-tonight counts through, and caps the areas listed", () => {
    const many = Array.from({ length: SUMMARY_AREAS_MAX + 20 }, (_, i) => g("pub_bar", `Area ${i}`, 1))
    const s = summarise(many as Parameters<typeof summarise>[0], new Map(), 4, 61)
    expect(s).toMatchObject({ liveCount: 4, openTonightCount: 61 })
    expect(s.areas).toHaveLength(SUMMARY_AREAS_MAX)
  })
})

describe("GET /api/mobile/venues/summary", () => {
  const req = (q = "") => new NextRequest(`https://api.blendn.app/api/mobile/venues/summary${q}`)

  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111" })
    mockDb.profiles.findUnique.mockResolvedValue({ age: null, date_of_birth: null, onboarded: false })
    mockDb.events.findMany.mockResolvedValue([])
    mockDb.venues.findMany.mockResolvedValue([])
    mockDb.venues.groupBy.mockResolvedValue([g("pub_bar", "Indiranagar", 2)])
  })

  it("refuses an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)
  })

  it("is one grouped read over the list's own venues, in the envelope", async () => {
    // A scope of its own: the summary keeps a minute per city.
    const res = await GET(req("?city=SummaryTestCity"))
    expect(res.status).toBe(200)
    expect(mockDb.venues.groupBy).toHaveBeenCalledTimes(1)
    const arg = mockDb.venues.groupBy.mock.calls[0][0]
    expect(arg.by).toEqual(["venue_type", "area", "area_slug"])
    expect(arg.where).toMatchObject({ deleted_at: null, status: "active", city: { equals: "summarytestcity", mode: "insensitive" } })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ total: 2, liveCount: 0, openTonightCount: 0 })
    expect(body.data.areas).toEqual([{ slug: "indiranagar", name: "Indiranagar", count: 2, liveCount: 0, typeMix: ["pub_bar"] }])
  })

  it("is kept a minute: a second read in the window does not ask again", async () => {
    await GET(req("?city=SummaryCacheCity"))
    await GET(req("?city=SummaryCacheCity"))
    expect(mockDb.venues.groupBy).toHaveBeenCalledTimes(1)
    await GET(req("?city=ElsewhereCity"))
    expect(mockDb.venues.groupBy).toHaveBeenCalledTimes(2)
  })

  it("never asks who is live of somebody the venue page would refuse", async () => {
    await GET(req("?city=NotOnboardedCity"))
    expect(mockDb.event_check_ins.findMany).not.toHaveBeenCalled()
  })

  it("refuses a malformed query", async () => {
    expect((await GET(req("?lat=north"))).status).toBe(400)
  })
})
