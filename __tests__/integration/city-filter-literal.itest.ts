import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))

import { getCurationQueue } from "@/app/dashboard/events/curate/queue-actions"

import { signAccessToken } from "@/lib/mobile-auth"

import { db, closeDb, makeUser, makeEvent, testId } from "./helpers"

/**
 * `?city=` is a city, not a pattern (SCRUM-473) — and the one the cache holds
 * (SCRUM-474).
 *
 * Both routes, and the admin curation queue, filter with Prisma's
 * `{ equals, mode: "insensitive" }`, which is ILIKE on Postgres, so `%` and `_`
 * in the value were wildcards: on staging `?city=%`, `?city=B%` and
 * `?city=_engaluru` all returned Bengaluru. The match stays case-insensitive —
 * "bengaluru" and "Bengaluru" are one place.
 *
 * The events cache keys on the trimmed, lower-cased city while the filter used
 * the raw one, so `?city=%20Bengaluru` found nothing and cached that empty page
 * under Bengaluru's key for every caller for 30 s. Each case below that could
 * be masked by a warm entry asks with its own `limit`, which is part of the key.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")

const users: string[] = []
const events: string[] = []
const venues: string[] = []
const CITY = `Qacity${testId("c").replace(/[^a-z0-9]/gi, "").slice(-8)}`
/**
 * A city whose name really contains the wildcard characters and the escape
 * character. Left unescaped, `\x` would match a plain "x", so this name would
 * not find itself.
 */
const ODD_CITY = `${CITY}_%\\x`
let auth: string
let eventId: string
let venueId: string
let oddVenueId: string

beforeAll(async () => {
  const admin = await makeUser(testId("city_admin"), "app_admin")
  users.push(admin)
  session = { user: { id: admin, role: "app_admin" } }
  const organiser = await makeUser(testId("city_org"), "organizer")
  const viewer = await makeUser(testId("city_viewer"))
  users.push(organiser, viewer)
  await db.profiles.create({ data: { id: viewer, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  auth = signAccessToken(viewer, email)

  eventId = await makeEvent(organiser)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { city: CITY, curated_at: new Date() } })

  venueId = (await db.venues.create({ data: { name: testId("city-venue"), city: CITY } })).id
  oddVenueId = (await db.venues.create({ data: { name: testId("city-venue-odd"), city: ODD_CITY } })).id
  venues.push(venueId, oddVenueId)
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function ids(route: typeof eventsRoute | typeof venuesRoute, path: string, city: string | null, limit: number) {
  const q = city === null ? "" : `&city=${encodeURIComponent(city)}`
  const res = await route.GET(
    new NextRequest(`http://localhost/api/mobile/${path}?limit=${limit}${q}`, {
      headers: { authorization: `Bearer ${auth}` },
    })
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  const rows = body.data.events ?? body.data.venues ?? body.data
  return (rows as { id: string }[]).map((r) => r.id)
}

const eventIds = (city: string | null, limit = 100) => ids(eventsRoute, "events", city, limit)
const venueIds = (city: string | null, limit = 100) => ids(venuesRoute, "venues", city, limit)

describe("GET /api/mobile/events?city=", () => {
  it("finds the city in any case", async () => {
    expect(await eventIds(CITY.toLowerCase())).toContain(eventId)
  })

  it("does not treat % or _ as wildcards", async () => {
    // No city is called "%", so nothing at all — not merely "not the fixture",
    // which a full page of other cities' events would also satisfy.
    expect(await eventIds("%")).toEqual([])
    expect(await eventIds(`${CITY.slice(0, 3)}%`)).toEqual([])
    expect(await eventIds(`_${CITY.slice(1)}`)).toEqual([])
  })

  it("answers a city ending in a backslash with nothing", async () => {
    expect(await eventIds(`${CITY}\\`)).toEqual([])
  })

  it("finds a padded city, and a padded request cannot empty the city for the next caller", async () => {
    const limit = 41
    expect(await eventIds(` ${CITY} `, limit)).toContain(eventId)
    expect(await eventIds(CITY, limit)).toContain(eventId)
  })

  it("treats a blank city as no city, and does not cache an empty page under the unfiltered key", async () => {
    const limit = 43
    await eventIds("   ", limit)
    expect((await eventIds(null, limit)).length).toBeGreaterThan(0)
  })
})

describe("GET /api/mobile/venues?city=", () => {
  it("finds the city in any case, and padded", async () => {
    expect(await venueIds(CITY.toUpperCase())).toContain(venueId)
    expect(await venueIds(` ${CITY} `)).toContain(venueId)
  })

  it("does not treat % or _ as wildcards", async () => {
    expect(await venueIds("%")).toEqual([])
    expect(await venueIds(`_${CITY.slice(1)}`)).toEqual([])
  })

  it("still finds a city whose name contains %, _ and a backslash", async () => {
    expect(await venueIds(ODD_CITY)).toEqual([oddVenueId])
  })
})

describe("getCurationQueue(city)", () => {
  const queued = async (city: string) => (await getCurationQueue(city)).rows.map((r: { id: string }) => r.id)

  it("finds the city in any case", async () => {
    expect(await queued(CITY.toLowerCase())).toContain(eventId)
  })

  it("does not treat % or _ as wildcards", async () => {
    expect(await queued("%")).toEqual([])
    expect(await queued(`_${CITY.slice(1)}`)).toEqual([])
  })
})
