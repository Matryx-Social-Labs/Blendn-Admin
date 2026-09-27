const mockAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  userLimit: jest.fn().mockReturnValue({ windowMs: 1, maxRequests: 99 }),
}))
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/footprint/route"
import { pointInPolygon } from "@/lib/geofence"

/*
 * SCRUM-351. The building outline used to be fetched from overpass-api.de by
 * the browser, with no User-Agent — against OSM's usage policy, the same thing
 * `/api/geocode` was written to stop — and "Couldn't reach OpenStreetMap" was
 * shown for a busy server and for a place with no building alike. The main
 * Overpass instance answered 504 after 8.7 s on 2026-09-27; a mirror answered.
 */
const lat = 12.9790449
const lng = 77.6406722
const building = {
  version: 0.6,
  elements: [
    {
      type: "way",
      id: 42,
      tags: { building: "yes", name: "Toit" },
      geometry: [
        { lat: lat - 0.0001, lon: lng - 0.0001 },
        { lat: lat - 0.0001, lon: lng + 0.0001 },
        { lat: lat + 0.0001, lon: lng + 0.0001 },
        { lat: lat + 0.0001, lon: lng - 0.0001 },
        { lat: lat - 0.0001, lon: lng - 0.0001 },
      ],
    },
  ],
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const gatewayTimeout = () => new Response("<html>504 Gateway Timeout</html>", { status: 504 })

const call = (qs: string) => GET(new NextRequest(`http://localhost/api/footprint?${qs}`))
const fetchMock = jest.fn()

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "organizer" } })
})

describe("GET /api/footprint — the building a pinned place sits in", () => {
  it("is for signed-in dashboard users only — not an open relay to Overpass", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await call(`lat=${lat}&lon=${lng}`)).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses coordinates that are not a place", async () => {
    expect((await call("lat=abc&lon=1")).status).toBe(400)
    expect((await call("lat=95&lon=1")).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns the building's outline, asked for as a cacheable GET with the product's User-Agent", async () => {
    fetchMock.mockResolvedValueOnce(json(building))
    const res = await call(`lat=${lat}&lon=${lng}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ring: [number, number][] | null }
    expect(pointInPolygon({ lat, lng }, body.ring!)).toBe(true)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/^https:\/\/overpass-api\.de\/api\/interpreter\?data=/)
    expect(new Headers(init.headers).get("User-Agent")).toMatch(/blendn/)
  })

  it("asks the mirror when the main server is busy", async () => {
    fetchMock.mockResolvedValueOnce(gatewayTimeout()).mockResolvedValueOnce(json(building))
    const res = await call(`lat=${lat}&lon=${lng}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ring: unknown }).ring).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).not.toMatch(/overpass-api\.de/)
  })

  it("says the lookup is unavailable — not that there is no building — when both fail", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError")).mockResolvedValueOnce(gatewayTimeout())
    const res = await call(`lat=${lat}&lon=${lng}`)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe("lookup_unavailable")
  })

  it("answers ring: null when OSM has no building there", async () => {
    fetchMock.mockResolvedValueOnce(json({ version: 0.6, elements: [] }))
    const res = await call(`lat=${lat}&lon=${lng}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ring: unknown }).ring).toBeNull()
  })
})
