jest.mock("@/lib/cities", () => jest.requireActual("./support/empty-catalogue"))
/*
 * GET /venues made eight statements in a row (profile, takeover check, page,
 * count, live guests, behind a rate limit). Each is a Singapore round trip, so
 * the list took the sum. These pin the shape: what is independent goes out
 * together, and what must come first still does.
 */
const mockDb = {
  profiles: { findUnique: jest.fn() },
  venues: { findMany: jest.fn(), count: jest.fn() },
  events: { findMany: jest.fn(), groupBy: jest.fn() },
  event_check_ins: { findMany: jest.fn() },
}
const mockLimit = jest.fn()
const mockTaken = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: async () => ({ userId: "11111111-1111-1111-1111-111111111111" }) }))
jest.mock("@/lib/venue-visibility", () => ({
  ...jest.requireActual("@/lib/venue-visibility"),
  venuesTakenOver: (...a: unknown[]) => mockTaken(...a),
}))
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: (...a: unknown[]) => mockLimit(...a),
  userLimit: () => ({}),
}))

import { NextRequest } from "next/server"

import { GET } from "@/app/api/mobile/venues/route"

const VENUE = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "The Humming Tree",
  address: null,
  city: "Bengaluru",
  latitude: 12.97,
  longitude: 77.59,
  capacity: null,
  venue_type: "pub_bar",
  floors: null,
  area: null,
  area_slug: null,
  timezone: "Asia/Kolkata",
  day_reset_hour: 6,
  hours: null,
  events: [],
}
const ADULT = { age: 30, date_of_birth: null, onboarded: true }
const tick = () => new Promise((r) => setImmediate(r))
const call = (q = "") => GET(new NextRequest(`https://api.blendn.app/api/mobile/venues${q}`))

/** A promise the test settles by hand, to see what has been asked while it is pending. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLimit.mockResolvedValue(null)
  mockTaken.mockResolvedValue([])
  mockDb.profiles.findUnique.mockResolvedValue(ADULT)
  mockDb.venues.findMany.mockResolvedValue([VENUE])
  mockDb.venues.count.mockResolvedValue(1)
  mockDb.events.findMany.mockResolvedValue([])
  mockDb.events.groupBy.mockResolvedValue([])
  mockDb.event_check_ins.findMany.mockResolvedValue([])
})

describe("GET /venues statement shape", () => {
  it("reads the profile while the rate limit is still being decided", async () => {
    const limit = deferred<null>()
    mockLimit.mockReturnValue(limit.promise)
    const pending = call()
    await tick()
    expect(mockDb.profiles.findUnique).toHaveBeenCalledTimes(1)
    limit.resolve(null)
    expect((await pending).status).toBe(200)
  })

  it("answers 429 from the limit, with no page read", async () => {
    mockLimit.mockResolvedValue(new Response("slow down", { status: 429 }))
    const res = await call()
    expect(res.status).toBe(429)
    expect(mockDb.venues.findMany).not.toHaveBeenCalled()
  })

  it("asks the page and its total together, after the takeover check", async () => {
    const takeover = deferred<string[]>()
    mockTaken.mockReturnValue(takeover.promise)
    const page = deferred<unknown[]>()
    mockDb.venues.findMany.mockReturnValue(page.promise)

    const pending = call()
    await tick()
    // The takeover rule decides which venues are listed: nothing is counted or paged before it.
    expect(mockDb.venues.findMany).not.toHaveBeenCalled()
    expect(mockDb.venues.count).not.toHaveBeenCalled()

    takeover.resolve([])
    await tick()
    // Both are in flight while the page is still pending.
    expect(mockDb.venues.findMany).toHaveBeenCalledTimes(1)
    expect(mockDb.venues.count).toHaveBeenCalledTimes(1)

    page.resolve([VENUE])
    const body = await (await pending).json()
    expect(body.data.venues).toHaveLength(1)
    expect(body.data.pagination.totalCount).toBe(1)
  })

  it("leaves a taken-over venue out of the page and out of the total", async () => {
    mockTaken.mockResolvedValue(["33333333-3333-3333-3333-333333333333"])
    await call()
    const want = { notIn: ["33333333-3333-3333-3333-333333333333"] }
    expect(mockDb.venues.findMany.mock.calls[0][0].where.id).toEqual(want)
    expect(mockDb.venues.count.mock.calls[0][0].where.id).toEqual(want)
  })
})
