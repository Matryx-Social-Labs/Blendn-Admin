import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { venueDayFor } from "@/lib/venue-day"

import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"
import { sqlCounter } from "./sql-count"

/**
 * GET /api/mobile/venues, Places (perf/hot-paths #6).
 *
 * The 60 s live-count cache steadied the bucket but saved no database work:
 * every request re-read every live guest of the venues first. `order=live`
 * read the live set three times, one row per guest, with the DISTINCT done in
 * JS; and each row's upcoming-event count was a relation `_count`. The
 * snapshots were taken BEFORE the change and must not move.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const counter = sqlCounter()
const users: string[] = []
const events: string[] = []
const venues: string[] = []
const HOUR = 3_600_000

afterAll(async () => {
  await counter.stop()
  await db.events.deleteMany({ where: { venue_id: { in: venues } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await closeDb()
})

const CLOCK_RELATIVE = new Set(["startTime", "endTime", "slug", "coverImageUrl", "title"])
function normalise(value: unknown, ids: Map<string, string>, tag: string): unknown {
  if (Array.isArray(value)) return value.map((v) => normalise(v, ids, tag))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([k]) => !CLOCK_RELATIVE.has(k)).map(([k, v]) => [k, normalise(v, ids, tag)])
    )
  }
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    if (!ids.has(value)) ids.set(value, `id${ids.size + 1}`)
    return ids.get(value)
  }
  return typeof value === "string" ? value.replace(tag, "TAG") : value
}

async function venueWith(tag: string, i: number, live: number, upcoming: number, viewerId: string) {
  const venue = await db.venues.create({
    data: {
      name: `${tag} place ${i}`,
      latitude: 12.97,
      longitude: 77.64,
      geofence: { type: "circle", lat: 12.97, lng: 77.64, radius: 60, buffer: 20 },
      timezone: "UTC",
      day_reset_hour: (new Date().getUTCHours() + 12) % 24,
    },
  })
  venues.push(venue.id)
  if (live > 0) {
    const day = await venueDayFor(venue.id)
    for (let g = 0; g < live; g++) {
      const guest = await makeUser(testId("pl_live"))
      users.push(guest)
      await db.event_check_ins.create({
        data: { event_id: day!.id, occurrence_id: day!.occurrenceId, user_id: guest, status: "checked_in", check_in_time: new Date(), expires_at: new Date(Date.now() + HOUR) },
      })
    }
  }
  for (let u = 0; u < upcoming; u++) {
    const start = new Date(Date.now() + (3 + u) * 24 * HOUR)
    const end = new Date(start.getTime() + 3 * HOUR)
    const event = await db.events.create({
      data: {
        slug: testId("plv"), title: `${tag} night ${u}`, description: "integration fixture",
        start_time: start, end_time: end, timezone: "UTC", status: "published", visibility: "public",
        organizer_id: viewerId, venue_id: venue.id, venue_link_status: "confirmed",
        occurrences: { create: { occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end } },
      },
    })
    events.push(event.id)
  }
}

async function world() {
  const tag = testId("pl").replace(/_/g, "")
  const viewerId = await makeUser(testId("pl_viewer"))
  users.push(viewerId)
  await onboard(viewerId)
  const adult = new Date(Date.now() - 30 * 365.25 * 86_400_000)
  await db.profiles.update({ where: { id: viewerId }, data: { date_of_birth: adult } })
  const token = signAccessToken(viewerId, `${viewerId}@itest.invalid`)
  // 5+ live is a bucket; one is "quiet". Counts of upcoming events differ per venue.
  await venueWith(tag, 1, 6, 2, viewerId)
  await venueWith(tag, 2, 11, 1, viewerId)
  await venueWith(tag, 3, 0, 3, viewerId)
  await venueWith(tag, 4, 1, 0, viewerId)
  const list = async (query = "") => {
    const { result, sql } = await counter.during(
      async () => (await venuesRoute.GET(new NextRequest(`http://localhost/api/mobile/venues?limit=50&sortBy=name&search=${tag}${query}`, { headers: { authorization: `Bearer ${token}` } }))) as Response
    )
    return { body: await result.json(), status: result.status, sql }
  }
  return { tag, list }
}

const liveReads = (sql: string[]) => sql.filter((q) => /event_check_ins/.test(q)).length

describe("the Places list", () => {
  it("lists the same rows, and reads the live guests once", async () => {
    const { tag, list } = await world()
    const { body, status, sql } = await list()
    expect(status).toBe(200)
    expect(normalise(body.data, new Map(), tag)).toMatchSnapshot()
    expect(liveReads(sql)).toBeLessThanOrEqual(1)
    // Within the minute the cache serves the bucket: no guest is read again.
    expect(liveReads((await list()).sql)).toBe(0)
  })

  it("under order=live reads no guest list again within the minute", async () => {
    const { tag, list } = await world()
    const cold = await list("&order=live")
    expect(cold.status).toBe(200)
    expect(normalise(cold.body.data, new Map(), tag)).toMatchSnapshot()
    // Cold: the distinct venues, their guests, and the page's venues that were not live (3, as before,
    // but the first no longer ships a row per guest).
    expect(liveReads(cold.sql)).toBeLessThanOrEqual(3)
    const warm = await list("&order=live")
    expect(normalise(warm.body.data, new Map(), tag)).toEqual(normalise(cold.body.data, new Map(), tag))
    // Warm: only the cheap distinct-venues read (3 before: every guest list was read again).
    expect(liveReads(warm.sql)).toBeLessThanOrEqual(1)
  })

  it("counts a page's upcoming events beside the page, not as a relation count over every event", async () => {
    const { list } = await world()
    const { sql } = await list()
    // The relation count joins a GROUP BY over every upcoming event on the platform.
    expect(sql.some((q) => /_aggr_count_events/.test(q))).toBe(false)
  })
})
