import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { closeDb, db, makeUser, testId } from "./helpers"

/**
 * Backend round 3 (SCRUM-1086), pulse-map board items 1–4:
 * 1. `bbox`: only what is in the map's view, and `pagination.totalCount` is how many are ("+N more · zoom in").
 * 2. `include=near` with a fix: is anything within 25 km, and if not, the nearest city the viewer may open that has
 *    something, with its distance ("Nothing near you yet · showing {city}").
 * 3. Featured with a fix: each carries its distance from it, nearest first.
 * 4. No fix, no distance: a box or no coordinates never yields one.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const listRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const detailRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")

const HOUR = 60 * 60 * 1000
const users: string[] = []
const events: string[] = []
const venues: string[] = []
let viewer = ""
let previewer = ""
const tag = Math.random().toString(36).slice(2, 8)
/** An uncatalogued city of our own, so the featured set is only ours. */
const FEATURED_CITY = `Qabe${tag.replace(/\d/g, "")}town`

/** Our map view, somewhere no other suite puts an event (Otago, NZ). */
const VIEW = "169.9,-45.1,170.1,-44.9"
const ids = {} as Record<"in1" | "in2" | "in3" | "outside" | "draftInside" | "mysuru" | "draftFar" | "toronto" | "fNear" | "fMid" | "fFar", string>

async function eventAt(
  lat: number,
  lon: number,
  over: Partial<{ city: string | null; status: "published" | "draft"; is_featured: boolean }> = {}
): Promise<string> {
  const start = new Date(Date.now() + HOUR)
  const end = new Date(Date.now() + 3 * HOUR)
  const row = await db.events.create({
    data: {
      slug: testId("bb"),
      title: `bbox ${tag}`,
      description: "map fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: over.status ?? "published",
      visibility: "public",
      organizer_id: users[0],
      latitude: lat,
      longitude: lon,
      city: over.city === undefined ? null : over.city,
      is_featured: over.is_featured ?? false,
    },
  })
  events.push(row.id)
  await db.event_occurrences.create({ data: { event_id: row.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end } })
  return row.id
}

const bearer = async (id: string) =>
  `Bearer ${signAccessToken(id, (await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })).email)}`
let auth = ""
let previewAuth = ""

beforeAll(async () => {
  users.push(await makeUser("bb_host", "organizer"))
  viewer = await makeUser("bb_viewer")
  previewer = await makeUser("bb_prev")
  users.push(viewer, previewer)
  await db.profiles.createMany({
    data: [
      { id: viewer, onboarded: true, date_of_birth: new Date("1990-01-01") },
      { id: previewer, onboarded: true, date_of_birth: new Date("1990-01-01") },
    ],
  })
  await db.market_previewers.create({ data: { user_id: previewer, market_code: "CA" } })
  auth = await bearer(viewer)
  previewAuth = await bearer(previewer)

  ids.in1 = await eventAt(-45.0, 170.0)
  ids.in2 = await eventAt(-45.01, 170.01)
  ids.in3 = await eventAt(-45.02, 170.02)
  ids.outside = await eventAt(-45.3, 170.0) // ~33 km south of in1: outside the view, inside a 50 km radius
  ids.draftInside = await eventAt(-45.0, 170.0, { status: "draft" })
  // Mysuru's centre: the nearest open city from the rural fix below (Bengaluru is further).
  ids.mysuru = await eventAt(12.2958, 76.6394, { city: "Mysuru" })
  ids.draftFar = await eventAt(12.6, 77.0, { status: "draft" })
  ids.toronto = await eventAt(43.6532, -79.3832, { city: "Toronto" })
  // Featured, at about 1, 3 and 5 km from (-46, 168).
  ids.fFar = await eventAt(-46.045, 168.0, { city: FEATURED_CITY, is_featured: true })
  ids.fNear = await eventAt(-46.009, 168.0, { city: FEATURED_CITY, is_featured: true })
  ids.fMid = await eventAt(-46.027, 168.0, { city: FEATURED_CITY, is_featured: true })

  const venue = async (lat: number, lon: number) => {
    const row = await db.venues.create({ data: { name: `bb-venue-${tag}`, latitude: lat, longitude: lon, status: "active" } })
    venues.push(row.id)
    return row.id
  }
  await venue(-45.0, 170.0)
  await venue(-45.3, 170.0)
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.market_previewers.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

type Listed = { id: string; distance: number | null; featured?: { rank: number } | null }
type Near = { reachKm: number; empty: boolean; nearestCity: { slug: string; name: string; country: string; distanceKm: number; centre: { latitude: number; longitude: number } } | null }

async function get(route: { GET: (r: NextRequest) => Promise<Response> }, path: string, authorization = auth) {
  const res = await route.GET(new NextRequest(`http://localhost${path}`, { headers: { authorization } }))
  return { status: res.status, body: await res.json() }
}
const list = async (query: string, authorization = auth) => {
  const { status, body } = await get(listRoute, `/api/mobile/events?${query}`, authorization)
  return {
    status,
    events: (status === 200 ? body.data.events : []) as Listed[],
    total: status === 200 ? (body.data.pagination.totalCount as number) : null,
    near: (status === 200 ? body.data.near : undefined) as Near | undefined,
  }
}

describe("GET /events?bbox= — the map's view, with its total", () => {
  it("lists only what is inside the box, published only, and counts all of it past a capped page", async () => {
    const got = await list(`bbox=${VIEW}&limit=2`)
    expect(got.status).toBe(200)
    expect(got.events).toHaveLength(2)
    expect(got.total).toBe(3)
    for (const e of got.events) expect([ids.in1, ids.in2, ids.in3]).toContain(e.id)
  })

  it("never yields a distance: a box is not a fix", async () => {
    const got = await list(`bbox=${VIEW}`)
    expect(got.events.map((e) => e.distance)).toEqual([null, null, null])
  })

  it("gives the distance from a fix sent beside it", async () => {
    const got = await list(`bbox=${VIEW}&lat=-45.0&lon=170.0`)
    const in1 = got.events.find((e) => e.id === ids.in1)
    expect(in1?.distance).toBeCloseTo(0, 3)
  })

  it("is not served another view's answer", async () => {
    await list(`bbox=${VIEW}`)
    const south = await list("bbox=169.9,-45.4,170.1,-45.2")
    expect(south.events.map((e) => e.id)).toEqual([ids.outside])
    expect(south.total).toBe(1)
  })

  it.each([
    ["a radius beside it", `bbox=${VIEW}&lat=-45&lon=170&radius=5`],
    ["three numbers", "bbox=169.9,-45.1,170.1"],
    ["south above north", "bbox=169.9,-44.9,170.1,-45.1"],
  ])("refuses %s with a 400", async (_label, query) => {
    expect((await list(query)).status).toBe(400)
  })

  it("leaves the centre+radius query installed apps send as it was", async () => {
    const near = await list("lat=-45.0&lon=170.0&radius=5")
    expect(near.events.map((e) => e.id).sort()).toEqual([ids.in1, ids.in2, ids.in3].sort())
    const wide = await list("lat=-45.0&lon=170.0&radius=50")
    expect(wide.events.map((e) => e.id)).toContain(ids.outside)
  })
})

describe("GET /venues?bbox=", () => {
  it("lists only the venues inside the box, and how many are", async () => {
    const { status, body } = await get(venuesRoute, `/api/mobile/venues?bbox=${VIEW}&limit=50`)
    expect(status).toBe(200)
    expect(body.data.venues.map((v: { id: string }) => v.id)).toEqual([venues[0]])
    expect(body.data.pagination.totalCount).toBe(1)
  })

  it("refuses a box beside a radius", async () => {
    expect((await get(venuesRoute, `/api/mobile/venues?bbox=${VIEW}&lat=-45&lon=170&radius=5`)).status).toBe(400)
  })
})

describe("GET /events?include=near — the nothing-near-you signal", () => {
  it("says something is near when an event is within 25 km of the fix", async () => {
    const got = await list("lat=-45.05&lon=170.0&include=near")
    expect(got.near).toEqual({ reachKm: 25, empty: false, nearestCity: null })
  })

  it("when nothing is, names the nearest open city with something on, and how far its centre is (a draft at the fix is not something)", async () => {
    const got = await list("lat=12.6&lon=77.0&include=near")
    expect(got.near?.empty).toBe(true)
    expect(got.near?.nearestCity).toMatchObject({ slug: "mysuru", name: "Mysuru", country: "IN", centre: { latitude: 12.2958, longitude: 76.6394 } })
    expect(got.near?.nearestCity?.distanceKm).toBeGreaterThan(45)
    expect(got.near?.nearestCity?.distanceKm).toBeLessThan(60)
  })

  it("is the same in any country: a city the viewer may not open is neither near nor named", async () => {
    const outsider = await list("lat=43.66&lon=-79.39&include=near")
    expect(outsider.near?.empty).toBe(true)
    expect(outsider.near?.nearestCity?.slug).not.toBe("toronto")
    const previewing = await list("lat=43.66&lon=-79.39&include=near", previewAuth)
    expect(previewing.near).toEqual({ reachKm: 25, empty: false, nearestCity: null })
  })

  it("is absent without a fix, and when not asked for", async () => {
    expect((await list("include=near")).near).toBeUndefined()
    expect((await list("lat=12.6&lon=77.0")).near).toBeUndefined()
  })
})

describe("featured with a fix: its distance, nearest first", () => {
  const featured = (fix: string) => list(`featured=true&city=${FEATURED_CITY}${fix}`)

  it("orders the five nearest first from the fix, each with its distance", async () => {
    const got = await featured("&lat=-46.0&lon=168.0")
    expect(got.events.map((e) => e.id)).toEqual([ids.fNear, ids.fMid, ids.fFar])
    const km = got.events.map((e) => e.distance as number)
    expect(km[0]).toBeCloseTo(1, 0)
    expect(km[2]).toBeCloseTo(5, 0)
  })

  it("with no fix, keeps the day's rotation (rank order) and carries no distance", async () => {
    const got = await featured("")
    expect(got.events.map((e) => e.featured?.rank)).toEqual([1, 2, 3])
    expect(got.events.map((e) => e.distance)).toEqual([null, null, null])
  })

  it("orders each caller from their own fix, never from another's cached answer", async () => {
    await featured("&lat=-46.0&lon=168.0")
    const south = await featured("&lat=-46.1&lon=168.0")
    expect(south.events.map((e) => e.id)).toEqual([ids.fFar, ids.fMid, ids.fNear])
  })
})

describe("no fix, no distance", () => {
  it("the list carries none without lat/lon", async () => {
    const got = await list(`city=${FEATURED_CITY}`)
    expect(got.events.length).toBe(3)
    expect(got.events.every((e) => e.distance === null)).toBe(true)
  })

  it("an event's page carries none without lat/lon, and one with them", async () => {
    const detail = async (query: string) => {
      const req = new NextRequest(`http://localhost/api/mobile/events/${ids.fNear}${query}`, { headers: { authorization: auth } })
      const res = await detailRoute.GET(req, { params: Promise.resolve({ eventId: ids.fNear }) })
      expect(res.status).toBe(200)
      return (await res.json()).data
    }
    expect((await detail("")).distance).toBeNull()
    expect((await detail("?lat=-46.0&lon=168.0")).distance).toBeCloseTo(1, 0)
  })
})
