/*
 * Four mobile payloads show event times and used to leave out the zone to read
 * them in: the attendance rows, the venue page's `tonight` and `upcoming` (and
 * the full `/upcoming` list), and Places' `nextEvent`. Each now carries
 * `timezone`, the event's own IANA zone (`events.timezone`, what
 * `GET /events/:id` sends). The fixtures are deliberately not Asia/Kolkata (the
 * venue default), nor the venue's zone, so a field taken from the venue, or a
 * hard-coded one, fails.
 */
process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { NextRequest } from "next/server"

import { signAccessToken } from "@/lib/mobile-auth"
import { resetMemoryStore } from "@/lib/rate-limit-store"

import { closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const detail = require("@/app/api/mobile/venues/[venueId]/route") as typeof import("@/app/api/mobile/venues/[venueId]/route")
const list = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")
const upcomingRoute = require("@/app/api/mobile/venues/[venueId]/upcoming/route") as typeof import("@/app/api/mobile/venues/[venueId]/upcoming/route")
const attendance = require("@/app/api/mobile/me/attendance/route") as typeof import("@/app/api/mobile/me/attendance/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const HOUR = 3_600_000
const DAY = 24 * HOUR
const TOKEN = `ztz${Date.now().toString(36).replace(/\d/g, "")}q`
const NEW_YORK = "America/New_York"
const LOS_ANGELES = "America/Los_Angeles"
const KOLKATA = "Asia/Kolkata"

const users: string[] = []
const venues: string[] = []
const events: string[] = []
let host: string
let viewer: { id: string; token: string }

type Ctx = { params: Promise<never> }
const get = (route: { GET: (r: NextRequest, c: Ctx) => Promise<Response> }, path: string, params: Record<string, string> = {}) =>
  route.GET(new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${viewer.token}` } }), {
    params: Promise.resolve(params) as Promise<never>,
  })
const data = async (res: Response) => {
  expect(res.status).toBe(200)
  return (await res.json()).data
}

async function venue(name: string) {
  const v = await db.venues.create({
    data: {
      name: `${TOKEN} ${name}`,
      city: `City${TOKEN}`,
      latitude: 12.97,
      longitude: 77.59,
      timezone: KOLKATA,
      geofence: { type: "circle", lat: 12.97, lng: 77.59, radius: 60 },
    },
  })
  venues.push(v.id)
  return v.id
}

/** An event in `timezone`, from `startsInHours` for two hours, at `venueId`. */
async function eventAt(venueId: string, startsInHours: number, timezone: string, data: Record<string, unknown> = {}) {
  const id = await makeEvent(host)
  events.push(id)
  await db.events.update({
    where: { id },
    data: {
      venue_id: venueId,
      timezone,
      start_time: new Date(Date.now() + startsInHours * HOUR),
      end_time: new Date(Date.now() + (startsInHours + 2) * HOUR),
      ...data,
    },
  })
  return id
}

beforeAll(async () => {
  host = await makeUser(testId("tz_host"))
  users.push(host)
  const id = await makeUser(testId("tz_viewer"))
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { age: 30, name: "Person tz" } })
  viewer = { id, token: signAccessToken(id, `${id}@itest.invalid`) }
})
beforeEach(() => resetMemoryStore())
afterAll(async () => {
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  const dayIds = (await db.events.findMany({ where: { venue_id: { in: venues } }, select: { id: true } })).map((e) => e.id)
  await db.event_occurrences.deleteMany({ where: { event_id: { in: [...events, ...dayIds] } } })
  await db.events.deleteMany({ where: { id: { in: [...events, ...dayIds] } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
}, 60_000)

describe("event items carry the event's own timezone", () => {
  it("GET /me/attendance: each past row says the zone its event is in", async () => {
    const start = new Date(Date.now() - 3 * DAY)
    const rows = [
      { label: "la", timezone: LOS_ANGELES },
      { label: "ist", timezone: KOLKATA },
    ]
    const ids: Record<string, string> = {}
    for (const [i, { label, timezone }] of rows.entries()) {
      const at = new Date(start.getTime() - i * DAY)
      const id = await makeEvent(host)
      events.push(id)
      await db.events.update({ where: { id }, data: { timezone, start_time: at, end_time: new Date(at.getTime() + 4 * HOUR) } })
      const occurrence = await db.event_occurrences.findFirstOrThrow({ where: { event_id: id }, select: { id: true } })
      await db.event_occurrences.update({ where: { id: occurrence.id }, data: { start_time: at, end_time: new Date(at.getTime() + 4 * HOUR) } })
      await db.event_check_ins.create({
        data: { event_id: id, occurrence_id: occurrence.id, user_id: viewer.id, kind: "attendee", status: "checked_out", check_in_time: at },
      })
      ids[label] = id
    }

    const res = await data(await get(attendance, "/api/mobile/me/attendance"))
    const zoneOf = (id: string) => res.events.find((e: { id: string }) => e.id === id)?.timezone
    expect(zoneOf(ids.la)).toBe(LOS_ANGELES)
    expect(zoneOf(ids.ist)).toBe(KOLKATA)
    // Additive: the fields the app already read are still there.
    expect(res.events[0]).toMatchObject({ start_time: expect.any(String), end_time: expect.any(String), venue_name: null })
  })

  it("GET /venues/:id: `tonight` and every `upcoming` item, and GET /venues/:id/upcoming, carry it", async () => {
    const v = await venue("Page")
    // Running now, confirmed at this venue: it is what the venue is doing tonight.
    const tonight = await eventAt(v, -1, NEW_YORK, { venue_link_status: "confirmed" })
    await db.event_occurrences.updateMany({
      where: { event_id: tonight },
      data: { start_time: new Date(Date.now() - HOUR), end_time: new Date(Date.now() + HOUR) },
    })
    const later = await eventAt(v, 30, LOS_ANGELES)
    const sooner = await eventAt(v, 5, KOLKATA)
    const zones = { [tonight]: NEW_YORK, [later]: LOS_ANGELES, [sooner]: KOLKATA }

    const page = await data(await get(detail, `/api/mobile/venues/${v}`, { venueId: v }))
    expect(page.tonight).toMatchObject({ id: tonight, timezone: NEW_YORK })
    const items: { id: string; timezone: string }[] = page.venue.upcoming
    expect(items.length).toBeGreaterThanOrEqual(2)
    for (const item of items) expect(item.timezone).toBe(zones[item.id])
    // The venue's own zone is a different thing and is unchanged.
    expect(page.venue.timezone).toBe(KOLKATA)

    const full = await data(await get(upcomingRoute, `/api/mobile/venues/${v}/upcoming`, { venueId: v }))
    expect(full.events.map((e: { id: string }) => e.id)).toEqual(items.map((e) => e.id))
    for (const item of full.events) expect(item.timezone).toBe(zones[item.id])
  })

  it("GET /venues: `nextEvent` carries the event's zone, not the venue's", async () => {
    const v = await venue("Card")
    const next = await eventAt(v, 6, NEW_YORK)
    await eventAt(v, 40, LOS_ANGELES)

    const res = await data(await get(list, `/api/mobile/venues?search=${TOKEN}%20Card`))
    expect(res.venues).toHaveLength(1)
    expect(res.venues[0].nextEvent).toMatchObject({ id: next, timezone: NEW_YORK })
  })
})
