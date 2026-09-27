let session: { user: { id: string; role: string } } | null = null
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { NextRequest } from "next/server"
import { createVenue, updateVenue } from "@/lib/venue-actions"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const updateRoute = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")

/*
 * Security review of SCRUM-352, and owner's ruling 3 (2026-09-27): an event
 * COPIES its venue's area when saved.
 *
 * Only the dashboard form copied it. The server stored whatever came in, and
 * check-in (`resolveFence`) falls back to the venue's area LIVE when an event
 * has none of its own. Once an organisation may edit the unclaimed venue it
 * added, that let organisation A move the check-in area of organisation B's
 * event at "its" venue — deny B's attendees at the door, or admit people who
 * were never there. The copy is now the server's, on every save that links a
 * venue, and the migration backfills events already linked.
 */
const users: string[] = []
const orgs: string[] = []
const events: string[] = []
const venues: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.event_details.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function organiser(label: string) {
  const id = await makeUser(testId(label), "organizer")
  users.push(id)
  const org = await db.organisations.create({
    data: { kind: "company", display_name: testId(`${label}-org`), status: "verified" },
  })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: id, role: "owner" } })
  return { id, as: () => (session = { user: { id, role: "organizer" } }) }
}

const c = { lat: 12.55 + Math.random() * 0.05, lng: 77.0 + Math.random() * 0.05 }
const d = 0.0012
const stadium = {
  type: "polygon",
  buffer: 20,
  ring: [
    [c.lat - d, c.lng - d],
    [c.lat - d, c.lng + d],
    [c.lat + d, c.lng + d],
    [c.lat + d, c.lng - d],
  ],
}
const moved = { ...stadium, ring: stadium.ring.map(([lat, lng]) => [lat + 0.001, lng]) } // ~110 m north: an edit the venue allows

async function venueByA() {
  const a = await organiser("ecv-a")
  a.as()
  const { id } = await createVenue({
    name: testId("A's Grounds"),
    venueType: "stadium",
    lat: c.lat,
    lng: c.lng,
    geofence: stadium,
    acknowledgedDuplicates: true,
  })
  venues.push(id)
  return { a, venueId: id }
}

const body = (extra: Record<string, unknown>) => ({
  title: testId("B's night"),
  description: "Security fixture: an event at another organisation's unclaimed venue.",
  full_description: "Security fixture.",
  start_time: new Date(Date.now() + 48 * 3_600_000).toISOString(),
  end_time: new Date(Date.now() + 51 * 3_600_000).toISOString(),
  timezone: "Asia/Kolkata",
  status: "draft",
  visibility: "public",
  latitude: c.lat,
  longitude: c.lng,
  ...extra,
})

const fenceOf = async (id: string) =>
  (await db.events.findUniqueOrThrow({ where: { id }, select: { geofence: true, check_in_radius: true } }))

describe("an event copies its venue's area — another organisation cannot move it", () => {
  it("create: B links A's venue without an area; A edits the venue; B's area does not move", async () => {
    const { a, venueId } = await venueByA()
    const b = await organiser("ecv-b")
    b.as()
    const res = await createRoute.POST(
      new NextRequest("http://localhost/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body({ venue_id: venueId, venue_name: "A's Grounds" })),
      })
    )
    expect(res.status).toBeLessThan(300)
    const { id } = (await res.json()) as { id: string }
    events.push(id)

    const saved = await fenceOf(id)
    expect(saved.geofence).toMatchObject({ type: "polygon", ring: stadium.ring })
    expect(saved.check_in_radius).toBeGreaterThanOrEqual(206)

    a.as()
    await updateVenue(venueId, { geofence: moved })
    expect((await fenceOf(id)).geofence).toMatchObject({ ring: stadium.ring })
  })

  it("update: linking the venue to an event with no area copies it", async () => {
    const { venueId } = await venueByA()
    const b = await organiser("ecv-b2")
    b.as()
    const created = await createRoute.POST(
      new NextRequest("http://localhost/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body({})),
      })
    )
    const { id } = (await created.json()) as { id: string }
    events.push(id)
    expect((await fenceOf(id)).geofence).toBeNull()

    const res = await updateRoute.PATCH(
      new NextRequest(`http://localhost/api/events/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ venue_id: venueId }),
      }),
      { params: Promise.resolve({ id }) }
    )
    expect(res.status).toBe(200)
    expect((await fenceOf(id)).geofence).toMatchObject({ type: "polygon", ring: stadium.ring })
  })

  it("an event that brings its own area keeps it — a rooftop at a three-floor venue", async () => {
    const { venueId } = await venueByA()
    const b = await organiser("ecv-b3")
    b.as()
    const rooftop = { type: "circle", lat: c.lat, lng: c.lng, radius: 15, buffer: 10 }
    const res = await createRoute.POST(
      new NextRequest("http://localhost/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body({ venue_id: venueId, geofence: rooftop })),
      })
    )
    const { id } = (await res.json()) as { id: string }
    events.push(id)
    expect((await fenceOf(id)).geofence).toMatchObject({ type: "circle", radius: 15 })
  })
})
