const mockAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  userLimit: jest.fn().mockReturnValue({ windowMs: 1, maxRequests: 99 }),
}))
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/geocode/route"

/*
 * SCRUM-351. A search for a stadium should bring its outline with it — the
 * geocoder already knows it (Nominatim `polygon_geojson`), and asking costs
 * nothing extra. A reverse lookup (pin → address) needs no outline.
 */
const fetchMock = jest.fn()
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response("[]", { status: 200 }))
  global.fetch = fetchMock as unknown as typeof fetch
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "organizer" } })
})

describe("the geocoder asks for a place's own outline", () => {
  it("requests polygon_geojson, simplified, on a search", async () => {
    await GET(new NextRequest("http://localhost/api/geocode?q=Chinnaswamy%20Stadium"))
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toMatch(/[?&]polygon_geojson=1(&|$)/)
    expect(url).toMatch(/[?&]polygon_threshold=0\.0000\d/)
  })

  it("does not on a reverse lookup, which only needs the address", async () => {
    await GET(new NextRequest("http://localhost/api/geocode?lat=12.97&lon=77.59"))
    expect(String(fetchMock.mock.calls[0][0])).not.toMatch(/polygon_geojson/)
  })
})

describe("the geocoder's upstream is configuration (SCRUM-357)", () => {
  // CI's e2e points it at a local stub of recorded OSM answers, so no test
  // run calls Nominatim — flaky, and against its usage policy at volume.
  afterEach(() => { delete process.env.GEOCODE_UPSTREAM })

  it("uses GEOCODE_UPSTREAM when it is set", async () => {
    process.env.GEOCODE_UPSTREAM = "http://127.0.0.1:4599"
    await GET(new NextRequest("http://localhost/api/geocode?q=Chinnaswamy"))
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^http:\/\/127\.0\.0\.1:4599\/search\?/)
  })

  it("is Nominatim when it is not", async () => {
    await GET(new NextRequest("http://localhost/api/geocode?q=Chinnaswamy"))
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/search\?/)
  })
})

