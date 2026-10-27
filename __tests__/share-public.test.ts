import { NextRequest } from "next/server"

jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
const hit = jest.fn()
jest.mock("@/lib/rate-limit-store", () => ({ hit: (...args: unknown[]) => hit(...args) }))

import { atTheVenueWhere } from "@/lib/venue-visibility"
import {
  publicCoverUrl,
  shareEventBody,
  shareNetworkFor,
  shareRateLimit,
  serveShare,
  shareState,
  tryAgainResponse,
  unavailableResponse,
} from "@/lib/share-public"

const SECRET = "share-proxy-secret-0123456789abcdef0123"
const NOW = new Date("2026-10-22T12:00:00Z")
const HOSTS = ["blendn-media.fly.storage.tigris.dev", "blendn-media.t3.storage.dev"]

beforeEach(() => {
  process.env.SHARE_PROXY_SECRET = SECRET
  hit.mockReset()
  hit.mockResolvedValue({ count: 1, resetAt: Date.now() + 60_000 })
})
afterAll(() => {
  delete process.env.SHARE_PROXY_SECRET
})

describe("publicCoverUrl", () => {
  const ok = "https://blendn-media.fly.storage.tigris.dev/events/u1/1-a-cover.jpg"

  it("keeps a cover under events/ on the public bucket, reduced to origin and path", () => {
    expect(publicCoverUrl(`${ok}?v=2#x`, HOSTS)).toBe(ok)
    expect(publicCoverUrl("https://blendn-media.t3.storage.dev/events/u1/c.webp", HOSTS)).toBe(
      "https://blendn-media.t3.storage.dev/events/u1/c.webp"
    )
  })

  it.each([
    ["null", null],
    ["empty", ""],
    ["not a URL", "not a url"],
    ["http", "http://blendn-media.fly.storage.tigris.dev/events/u1/c.jpg"],
    ["another host", "https://evil.example/events/u1/c.jpg"],
    ["a lookalike host", "https://blendn-media.fly.storage.tigris.dev.evil.example/events/u1/c.jpg"],
    ["userinfo", "https://blendn-media.fly.storage.tigris.dev@evil.example/events/u1/c.jpg"],
    ["userinfo before the bucket", "https://x:y@blendn-media.fly.storage.tigris.dev/events/u1/c.jpg"],
    ["a port", "https://blendn-media.fly.storage.tigris.dev:8443/events/u1/c.jpg"],
    ["another folder", "https://blendn-media.fly.storage.tigris.dev/profile/u1/c.jpg"],
    ["the private bucket", "https://blendn-media-private.fly.storage.tigris.dev/events/u1/c.jpg"],
    ["a traversal out of events/", "https://blendn-media.fly.storage.tigris.dev/events/../profile/u1/c.jpg"],
    ["an encoded traversal", "https://blendn-media.fly.storage.tigris.dev/events/%2e%2e/profile/u1/c.jpg"],
    ["the folder itself", "https://blendn-media.fly.storage.tigris.dev/events/"],
    ["an encoded slash", "https://blendn-media.fly.storage.tigris.dev/events%2F..%2Fprofile/u1/c.jpg"],
    ["an encoded backslash", "https://blendn-media.fly.storage.tigris.dev/events/u1%5C..%5Cc.jpg"],
    ["a lower-case encoded slash", "https://blendn-media.fly.storage.tigris.dev/events/u1%2fc.jpg"],
    ["a link-local address", "https://169.254.169.254/events/u1/c.jpg"],
  ])("drops %s", (_label, raw) => {
    expect(publicCoverUrl(raw, HOSTS)).toBeNull()
  })

  describe("Unsplash photos", () => {
    const photo = "https://images.unsplash.com/photo-1511795409834-ef04bbd61622"
    const ours = `${photo}?auto=format&fit=crop&w=1200&q=80`

    it("accepts a photo URL and replaces its query with ours", () => {
      expect(publicCoverUrl(`${photo}?ixlib=rb-4.0.3&w=400&q=60&evil=1#frag`, HOSTS)).toBe(ours)
      expect(publicCoverUrl(photo, HOSTS)).toBe(ours)
    })

    it("does not need the bucket host list", () => {
      expect(publicCoverUrl(photo, [])).toBe(ours)
    })

    it.each([
      ["a lookalike host", "https://images.unsplash.com.evil.com/photo-1511795409834-ef04bbd61622"],
      ["http", "http://images.unsplash.com/photo-1511795409834-ef04bbd61622"],
      ["credentials", "https://user:pw@images.unsplash.com/photo-1511795409834-ef04bbd61622"],
      ["an @ host trick", "https://images.unsplash.com@evil.com/photo-1511795409834-ef04bbd61622"],
      ["a port", "https://images.unsplash.com:8443/photo-1511795409834-ef04bbd61622"],
      ["a traversal", "https://images.unsplash.com/photo-x/../../x"],
      ["an encoded slash", "https://images.unsplash.com/photo-1511795409%2f1234567"],
      ["an encoded backslash", "https://images.unsplash.com/photo-1511795409%5c1234567"],
      ["the wrong path", "https://images.unsplash.com/photos/1511795409834-ef04bbd61622"],
      ["a sub-path", "https://images.unsplash.com/photo-1511795409834-ef04bbd61622/x"],
      ["another Unsplash host", "https://plus.unsplash.com/photo-1511795409834-ef04bbd61622"],
      ["an empty id", "https://images.unsplash.com/photo-"],
      ["a too-short id", "https://images.unsplash.com/photo-abc"],
      ["a too-long id", `https://images.unsplash.com/photo-${"a".repeat(81)}`],
    ])("drops %s", (_label, raw) => {
      expect(publicCoverUrl(raw, HOSTS)).toBeNull()
    })
  })
})

describe("shareState", () => {
  const future = new Date(NOW.getTime() + 3_600_000)
  const past = new Date(NOW.getTime() - 3_600_000)

  it("maps status and clock to upcoming, cancelled or ended", () => {
    expect(shareState("published", future, NOW)).toBe("upcoming")
    expect(shareState("published", past, NOW)).toBe("ended")
    expect(shareState("published", NOW, NOW)).toBe("ended")
    expect(shareState("completed", future, NOW)).toBe("ended")
    expect(shareState("cancelled", future, NOW)).toBe("cancelled")
    expect(shareState("cancelled", past, NOW)).toBe("cancelled")
  })
})

describe("shareEventBody", () => {
  const venue = { id: "5b2c1d3e-0000-4000-8000-000000000001", name: "Toit", status: "active" as const, deleted_at: null, geofence: null, area: "Indiranagar" }
  const row = (visibility: "public" | "unlisted") => ({
    id: "5b2c1d3e-0000-4000-8000-000000000002",
    title: "Rooftop Sessions",
    description: "Bring a friend. Doors at Toit, 100 Feet Road.",
    start_time: new Date(NOW.getTime() + 3_600_000),
    end_time: new Date(NOW.getTime() + 7_200_000),
    timezone: "Asia/Kolkata",
    status: "published",
    visibility,
    min_age: 18,
    venue_name: "Toit",
    address: "298, 100 Feet Road, Indiranagar",
    city: "Bengaluru",
    cover_image_url: "https://blendn-media.fly.storage.tigris.dev/events/u1/c.jpg",
    venue_link_status: "confirmed" as const,
    geofence: null,
    latitude: 12.97,
    longitude: 77.64,
    venue,
  })
  const upcoming = [{ id: "5b2c1d3e-0000-4000-8000-000000000003", title: "Quiz night", start_time: NOW, end_time: NOW, timezone: "Asia/Kolkata" }]

  it("gives a public event its place, description and the venue's other events", () => {
    const { event } = shareEventBody(row("public"), upcoming, NOW)
    expect(event.indexable).toBe(true)
    expect(event.description).toContain("Toit")
    expect(event.place).toEqual({ venue: { id: venue.id, name: "Toit" }, name: "Toit", address: "298, 100 Feet Road, Indiranagar", area: "Indiranagar" })
    expect(event.venueUpcoming).toHaveLength(1)
    expect(event.coverUrl).toContain("/events/")
  })

  it("never says the venue's name for an unlisted event: area only, no description, no other events, not indexable", () => {
    const body = shareEventBody(row("unlisted"), upcoming, NOW)
    const json = JSON.stringify(body)
    expect(json).not.toContain("Toit")
    expect(json).not.toContain("100 Feet")
    expect(json).not.toContain("Quiz night")
    expect(body.event.indexable).toBe(false)
    expect(body.event.description).toBeNull()
    expect(body.event.place).toEqual({ venue: null, name: null, address: null, area: "Indiranagar" })
    expect(body.event.venueUpcoming).toEqual([])
    expect(body.event.coverUrl).toBeNull()
  })

  it("falls back to the city when no venue is confirmed", () => {
    const { event } = shareEventBody({ ...row("unlisted"), venue: null }, [], NOW)
    expect(event.place.area).toBe("Bengaluru")
  })
})

describe("the unavailable answer", () => {
  it("is the same bytes and headers every time, and is not the failed-read answer", async () => {
    const [a, b] = [unavailableResponse(), unavailableResponse()]
    expect(a.status).toBe(404)
    expect(await a.text()).toBe(await b.text())
    expect([...a.headers]).toEqual([...b.headers])
    expect(a.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=60")
    const retry = tryAgainResponse()
    expect(retry.status).toBe(503)
    expect(retry.headers.get("cache-control")).toBe("no-store")
  })
})

describe("the rate-limit network", () => {
  const headers = (h: Record<string, string>) => new Headers(h)

  it("believes x-share-client only from a caller holding the secret", () => {
    expect(shareNetworkFor(headers({ "x-real-ip": "198.51.100.7", "x-share-proxy": SECRET, "x-share-client": "203.0.113.9" }))).toBe("203.0.113.9")
  })

  it("ignores a forged client header: no secret, a wrong secret, a short one", () => {
    const forged = { "x-real-ip": "198.51.100.7", "x-share-client": "203.0.113.9" }
    expect(shareNetworkFor(headers(forged))).toBe("198.51.100.7")
    expect(shareNetworkFor(headers({ ...forged, "x-share-proxy": SECRET.slice(0, -1) + "X" }))).toBe("198.51.100.7")
    expect(shareNetworkFor(headers({ ...forged, "x-share-proxy": SECRET.slice(0, 10) }))).toBe("198.51.100.7")
  })

  it("believes nobody when the secret is unset or too short", () => {
    const sent = { "x-real-ip": "198.51.100.7", "x-share-proxy": "short", "x-share-client": "203.0.113.9" }
    process.env.SHARE_PROXY_SECRET = "short"
    expect(shareNetworkFor(headers(sent))).toBe("198.51.100.7")
    delete process.env.SHARE_PROXY_SECRET
    expect(shareNetworkFor(headers({ ...sent, "x-share-proxy": "" }))).toBe("198.51.100.7")
  })

  it("ignores a forwarded value that is not an address, even from the landing", () => {
    expect(shareNetworkFor(headers({ "x-real-ip": "198.51.100.7", "x-share-proxy": SECRET, "x-share-client": "not-an-ip" }))).toBe("198.51.100.7")
  })

  it("keys every path under one fixed key and refuses without caching", async () => {
    const req = (path: string) =>
      new NextRequest(`http://localhost${path}`, { headers: { "x-real-ip": "198.51.100.7" } })
    await shareRateLimit(req("/api/public/share/events/a"))
    await shareRateLimit(req("/api/public/share/venues/b"))
    expect(hit.mock.calls.map((c) => c[0])).toEqual(["rl:share:198.51.100.7", "rl:share:198.51.100.7"])

    hit.mockResolvedValue({ count: 121, resetAt: Date.now() + 30_000 })
    const limited = await shareRateLimit(req("/api/public/share/events/c"))
    expect(limited?.status).toBe(429)
    expect(limited?.headers.get("cache-control")).toBe("no-store")
  })
})

describe("serveShare", () => {
  const req = () => new NextRequest("http://localhost/api/public/share/events/x", { headers: { "x-real-ip": "198.51.100.7" } })

  it("answers a read that throws with the uncached 503, never the unavailable 404", async () => {
    const res = await serveShare(req(), "x", async () => {
      throw new Error("db down")
    })
    expect(res.status).toBe(503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ available: false, retry: true })
  })

  it("answers a null read with the unavailable 404 and a body with a 200", async () => {
    expect((await serveShare(req(), "x", async () => null)).status).toBe(404)
    const ok = await serveShare(req(), "x", async () => ({ available: true }))
    expect(ok.status).toBe(200)
    expect(ok.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=60")
  })
})

describe("atTheVenueWhere", () => {
  type Box = { latitude: { gte: number; lte: number }; longitude: { gte: number; lte: number } }
  const boxOf = (where: object) => (where as { OR: unknown[] }).OR[1] as Box

  it("is a confirmed link, or a pin in a box around the venue's area and buffer", () => {
    const where = atTheVenueWhere({ type: "circle", lat: 12.97, lng: 77.64, radius: 100, buffer: 50 })
    expect((where as { OR: unknown[] }).OR[0]).toEqual({ venue_link_status: "confirmed" })
    const box = boxOf(where)
    // Around the centre, wider than radius + buffer (150 m is about 0.00135 degrees of latitude), and nowhere near 0.1 degrees.
    expect(box.latitude.gte).toBeLessThan(12.97 - 0.00135)
    expect(box.latitude.lte).toBeGreaterThan(12.97 + 0.00135)
    expect(box.latitude.lte - box.latitude.gte).toBeLessThan(0.01)
    expect(box.longitude.gte).toBeLessThan(77.64)
    expect(box.longitude.lte).toBeGreaterThan(77.64)
  })

  it("covers a polygon's furthest corner", () => {
    const ring: [number, number][] = [[12.97, 77.64], [12.97, 77.65], [12.98, 77.65], [12.98, 77.64]]
    const box = boxOf(atTheVenueWhere({ type: "polygon", ring, buffer: 20 }))
    for (const [lat, lng] of ring) {
      expect(lat).toBeGreaterThanOrEqual(box.latitude.gte)
      expect(lat).toBeLessThanOrEqual(box.latitude.lte)
      expect(lng).toBeGreaterThanOrEqual(box.longitude.gte)
      expect(lng).toBeLessThanOrEqual(box.longitude.lte)
    }
  })

  it("is a confirmed link only for a venue with no area", () => {
    expect(atTheVenueWhere(null)).toEqual({ venue_link_status: "confirmed" })
    expect(atTheVenueWhere({ type: "circle", lat: 999, lng: 0, radius: 10, buffer: 0 })).toEqual({ venue_link_status: "confirmed" })
  })
})
