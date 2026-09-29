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
 * `?city=` is a city, not a pattern (SCRUM-473).
 *
 * Both routes, and the admin curation queue, filter with Prisma's
 * `{ equals, mode: "insensitive" }`, which is ILIKE on Postgres, so `%` and `_`
 * in the value were wildcards: on staging
 * `?city=%`, `?city=B%` and `?city=_engaluru` all returned Bengaluru. The match
 * stays case-insensitive — "bengaluru" and "Bengaluru" are one place.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")

const users: string[] = []
const events: string[] = []
const venues: string[] = []
const CITY = `Qacity${testId("c").replace(/[^a-z0-9]/gi, "").slice(-8)}`
let auth: string
let eventId: string
let venueId: string

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
  venues.push(venueId)
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function ids(route: typeof eventsRoute | typeof venuesRoute, path: string, city: string) {
  const res = await route.GET(
    new NextRequest(`http://localhost/api/mobile/${path}?limit=100&city=${encodeURIComponent(city)}`, {
      headers: { authorization: `Bearer ${auth}` },
    })
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  const rows = body.data.events ?? body.data.venues ?? body.data
  return (rows as { id: string }[]).map((r) => r.id)
}

const eventIds = (city: string) => ids(eventsRoute, "events", city)
const venueIds = (city: string) => ids(venuesRoute, "venues", city)

describe("GET /api/mobile/events?city=", () => {
  it("finds the city in any case", async () => {
    expect(await eventIds(CITY.toLowerCase())).toContain(eventId)
  })

  it("does not treat % or _ as wildcards", async () => {
    expect(await eventIds("%")).not.toContain(eventId)
    expect(await eventIds(`${CITY.slice(0, 3)}%`)).not.toContain(eventId)
    expect(await eventIds(`_${CITY.slice(1)}`)).not.toContain(eventId)
  })
})

describe("GET /api/mobile/venues?city=", () => {
  it("finds the city in any case", async () => {
    expect(await venueIds(CITY.toUpperCase())).toContain(venueId)
  })

  it("does not treat % or _ as wildcards", async () => {
    expect(await venueIds("%")).not.toContain(venueId)
    expect(await venueIds(`_${CITY.slice(1)}`)).not.toContain(venueId)
  })
})

describe("getCurationQueue(city)", () => {
  const queued = async (city: string) => (await getCurationQueue(city)).rows.map((r: { id: string }) => r.id)

  it("finds the city in any case", async () => {
    expect(await queued(CITY.toLowerCase())).toContain(eventId)
  })

  it("does not treat % or _ as wildcards", async () => {
    expect(await queued("%")).not.toContain(eventId)
    expect(await queued(`_${CITY.slice(1)}`)).not.toContain(eventId)
  })
})
