import { NextRequest } from "next/server"

const profile = jest.fn()
const events = jest.fn()
const venues = jest.fn()

jest.mock("@/lib/db", () => ({
  db: {
    profiles: { findUnique: (...a: unknown[]) => profile(...a) },
    events: { findMany: (...a: unknown[]) => events(...a) },
    venues: { findMany: (...a: unknown[]) => venues(...a) },
  },
}))
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: async () => ({ userId: "u1" }) }))
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }))

import { GET } from "@/app/api/mobile/events/cities/route"
import { clearCityPlaces } from "./support/city-places"

const call = () => GET(new NextRequest("http://localhost/api/mobile/events/cities"))
const PLACE = { city: "Bengaluru", latitude: 12.97, longitude: 77.59 }

beforeEach(() => {
  jest.clearAllMocks()
  clearCityPlaces()
  profile.mockResolvedValue(null)
  events.mockResolvedValue([])
  venues.mockResolvedValue([PLACE])
})
afterEach(() => jest.useRealTimers())

describe("GET /events/cities", () => {
  it("asks for the places while the profile is still loading, not after the events", async () => {
    let finishProfile: (v: unknown) => void = () => {}
    profile.mockReturnValue(new Promise((resolve) => (finishProfile = resolve)))

    const pending = call()
    await new Promise((r) => setImmediate(r))
    expect(venues).toHaveBeenCalledTimes(1)
    expect(events).not.toHaveBeenCalled()

    finishProfile(null)
    const body = await (await pending).json()
    expect(body.data.cities).toEqual([expect.objectContaining({ city: "Bengaluru", placeCount: 1 })])
  })

  it("scans the venues once for requests within 60 s, and again after", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] })
    await call()
    jest.advanceTimersByTime(59_000)
    await call()
    expect(venues).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(2_000)
    await call()
    expect(venues).toHaveBeenCalledTimes(2)
  })

  it("shares one scan between requests that arrive together", async () => {
    await Promise.all([call(), call(), call()])
    expect(venues).toHaveBeenCalledTimes(1)
  })

  it("does not cache a failed scan", async () => {
    venues.mockRejectedValueOnce(new Error("db down"))
    expect((await call()).status).toBe(500)
    expect((await call()).status).toBe(200)
    expect(venues).toHaveBeenCalledTimes(2)
  })

  it("still applies the viewer's age to events but not to places", async () => {
    profile.mockResolvedValue({ age: 19, date_of_birth: null })
    await call()
    expect(events.mock.calls[0][0].where.OR).toEqual([{ min_age: null }, { min_age: { lte: 19 } }])
  })
})
