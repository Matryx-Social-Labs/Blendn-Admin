/*
 * Hotspots — the venue feed behind the Pulse/Hotspots switch.
 *
 * Two things here are worth a test rather than a read-through, because both
 * fail *quietly*:
 *
 *  1. **The age gate reaches `nextEvent`.** The events feed hides 18+ events
 *     from a sixteen-year-old. This endpoint surfaces a real event as the
 *     headline of a venue card — title, cover art and all — so if the filter is
 *     not applied here too, the event the feed correctly hid reappears one
 *     screen over. Nothing goes red when that happens; the card just renders.
 *
 *  2. **The count and the headline use the same filter.** `upcomingEventCount`
 *     and `nextEvent` are two reads of one question. When these are allowed to
 *     drift, a card says "3 upcoming" and then headlines an event that is not
 *     one of them, which is the sort of thing nobody reports and nobody can
 *     reproduce.
 *
 * The Prisma call is asserted on rather than the SQL: the point is that the
 * route *asks* the right question, and the arguments are where that lives.
 */

const mockDb = {
  profiles: { findUnique: jest.fn() },
  venues: { findMany: jest.fn(), count: jest.fn() },
  // The hiding rule's one read (`venuesTakenOver`); nothing takes a venue over here.
  events: { findMany: jest.fn() },
  // `liveGuestIds`: nobody live.
  event_check_ins: { findMany: jest.fn() },
}

const mockAuth = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/mobile-auth", () => ({
  getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a),
}))

import { NextRequest } from "next/server"

import { GET } from "@/app/api/mobile/venues/route"

const VIEWER = "11111111-1111-1111-1111-111111111111"

const req = (query = "") =>
  new NextRequest(`https://api.blendn.app/api/mobile/venues${query}`)

/** One venue row in the shape the route's `select` produces. */
const venueRow = (over: Record<string, unknown> = {}) => ({
  id: "22222222-2222-2222-2222-222222222222",
  name: "The Humming Tree",
  address: "12 Indiranagar",
  city: "Bengaluru",
  latitude: 12.97,
  longitude: 77.59,
  capacity: 300,
  venue_type: "live_music_venue",
  _count: { events: 2 },
  events: [
    {
      id: "33333333-3333-3333-3333-333333333333",
      title: "Friday session",
      slug: "friday-session",
      cover_image_url: "https://cdn.example/cover.jpg",
      start_time: new Date("2026-09-01T18:00:00.000Z"),
      end_time: new Date("2026-09-01T23:00:00.000Z"),
    },
  ],
  ...over,
})


beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: VIEWER })
  mockDb.profiles.findUnique.mockResolvedValue({ age: null, date_of_birth: null })
  mockDb.venues.findMany.mockResolvedValue([venueRow()])
  mockDb.venues.count.mockResolvedValue(1)
  mockDb.events.findMany.mockResolvedValue([])
  mockDb.event_check_ins.findMany.mockResolvedValue([])
})

/** The `select` the route handed Prisma on its one full fetch. */
const selectArg = () => mockDb.venues.findMany.mock.calls[0][0].select

describe("GET /api/mobile/venues", () => {
  it("refuses an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(mockDb.venues.findMany).not.toHaveBeenCalled()
  })

  it("serves active, undeleted venues only", async () => {
    await GET(req())
    const where = mockDb.venues.findMany.mock.calls[0][0].where
    // `archived` is how a venue is retired without deleting its history. A
    // discovery feed that shows one is offering a place that is not open.
    expect(where).toMatchObject({ deleted_at: null, status: "active" })
  })

  it("applies the caller's age to the event it headlines", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({
      age: null,
      date_of_birth: "2010-01-01",
    })

    await GET(req())

    const nested = selectArg().events.where
    // Beside the link's OR, under `AND`, so neither replaces the other (F4).
    expect(nested.AND).toContainEqual({ OR: [{ min_age: null }, { min_age: { lte: 16 } }] })
    expect(nested).toMatchObject({ status: "published", visibility: "public" })
  })

  it("counts and headlines with the same filter", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({
      age: null,
      date_of_birth: "2010-01-01",
    })

    await GET(req())

    const select = selectArg()
    // Identity, not deep-equality by luck: the route builds one object and uses
    // it twice, which is the only way these cannot drift apart later.
    expect(select._count.select.events.where).toBe(select.events.where)
  })

  it("hides nothing when the age is unknown", async () => {
    // Most OAuth accounts have no age. Failing closed would empty the screen to
    // punish a missing field — the events feed made this decision first.
    await GET(req())
    expect(JSON.stringify(selectArg().events.where)).not.toContain("min_age")
  })

  it("does not filter by radius unless a radius was asked for", async () => {
    // Sending coordinates means "sort by distance". A default radius here would
    // reproduce the 10km box that blanked the events feed.
    await GET(req("?lat=12.97&lon=77.59&sortBy=distance"))
    const where = mockDb.venues.findMany.mock.calls[0][0].where
    expect(where.latitude).toBeUndefined()
    expect(where.longitude).toBeUndefined()
  })

  it("bounds the box when a radius was asked for", async () => {
    await GET(req("?lat=12.97&lon=77.59&radius=5&sortBy=distance"))
    const where = mockDb.venues.findMany.mock.calls[0][0].where
    expect(where.latitude).toEqual(
      expect.objectContaining({ gte: expect.any(Number), lte: expect.any(Number) })
    )
  })

  it("labels the venue type rather than shipping the raw enum", async () => {
    const res = await GET(req())
    const body = await res.json()
    expect(body.data.venues[0].venueTypeLabel).toBe("Live music venue")
    expect(body.data.venues[0].venueType).toBe("live_music_venue")
  })

  it("returns a distance only when both sides have a fix", async () => {
    mockDb.venues.findMany.mockResolvedValue([venueRow({ latitude: null, longitude: null })])
    const res = await GET(req("?lat=12.97&lon=77.59"))
    const body = await res.json()
    // Not 0, and not "very far" — unknown. A card that reads "0.0 km" for a
    // venue with no coordinates is a lie the user acts on.
    expect(body.data.venues[0].distance).toBeNull()
  })

  it("says nothing is on rather than inventing something", async () => {
    mockDb.venues.findMany.mockResolvedValue([venueRow({ events: [], _count: { events: 0 } })])
    const res = await GET(req())
    const body = await res.json()
    expect(body.data.venues[0].nextEvent).toBeNull()
    expect(body.data.venues[0].upcomingEventCount).toBe(0)
  })

  it("leaves out the venues an event has taken over, and says liveNow as a bucket to an adult", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: 30, date_of_birth: null, onboarded: true })
    // A confirmed link takes the venue over wherever the event's area is
    // (`atTheVenue`); the integration suite walks every other link state.
    const taken = "44444444-4444-4444-4444-444444444444"
    mockDb.events.findMany.mockResolvedValue([
      { id: "e", title: "t", venue_id: taken, venue_link_status: "confirmed", geofence: null, latitude: null, longitude: null, venue: { geofence: null } },
    ])
    const res = await GET(req())
    expect(mockDb.venues.findMany.mock.calls[0][0].where.id).toEqual({ notIn: [taken] })
    expect((await res.json()).data.venues[0].liveNow).toBe("quiet")
  })

  it("tells nobody the venue page would refuse how many are live: unknown age, under 18, not onboarded", async () => {
    for (const viewer of [
      { age: null, date_of_birth: null, onboarded: true },
      { age: 16, date_of_birth: null, onboarded: true },
      { age: null, date_of_birth: null, onboarded: false },
    ]) {
      mockDb.profiles.findUnique.mockResolvedValue(viewer)
      const res = await GET(req())
      expect((await res.json()).data.venues[0].liveNow).toBeNull()
    }
    // And never asked: the count is not read for somebody it is not for.
    expect(mockDb.event_check_ins.findMany).not.toHaveBeenCalled()
  })

  it("rejects a venue type outside the vocabulary", async () => {
    const res = await GET(req("?venueType=speakeasy"))
    expect(res.status).toBe(400)
  })

  it("carries no field shaped like a person", async () => {
    // A blunt sweep. `venues` has an `owner_id` and a `created_by`, and the
    // failure mode for every leak this codebase has had is a field nobody
    // remembered was on the row.
    const res = await GET(req())
    const body = JSON.stringify(await res.json())
    for (const leak of ["owner_id", "created_by", "owner_org_id", "date_of_birth", "email"]) {
      expect(body).not.toContain(leak)
    }
  })
})
