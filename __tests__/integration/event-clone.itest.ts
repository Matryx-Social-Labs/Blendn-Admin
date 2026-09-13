import { NextRequest } from "next/server"

/*
 * A clone keeps what was drawn around the pin, not only the pin.
 *
 * Read back on 2026-09-13: the source had a 40m circle with a 20m buffer, a
 * venue link and a door policy; the copy had `geofence` null, `venue_id` null
 * and the defaults for the rest. The room then checked people in against the
 * 100m legacy circle, and the venue owner lost the copy from "events at my
 * venue". A static scan cannot see a column that is simply not in a `create`;
 * this posts the route and reads the row.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cloneRoute = require("@/app/api/mobile/events/[eventId]/clone/route") as
  typeof import("@/app/api/mobile/events/[eventId]/clone/route")

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []

afterAll(async () => {
  await cleanup(users, events)
  if (venues.length) await db.venues.deleteMany({ where: { id: { in: venues } } })
  if (orgs.length) await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  if (orgs.length) await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

const FENCE = { type: "circle", lat: 12.9716, lng: 77.5946, radius: 40, buffer: 20 }

async function organiserWithEvent(link: "auto_linked" | "disputed") {
  const org = await db.organisations.create({ data: { display_name: `Clone Org ${testId("o")}` } })
  orgs.push(org.id)
  const organiser = await makeUser(testId("cl_org"), "organizer")
  users.push(organiser)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: organiser, role: "owner" } })
  const venue = await db.venues.create({ data: { name: `Clone Venue ${testId("v")}`, capacity: 80 } })
  venues.push(venue.id)

  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("cl"),
      title: `Source ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(now + 24 * 3600 * 1000),
      end_time: new Date(now + 26 * 3600 * 1000),
      timezone: "Asia/Kolkata",
      status: "published",
      organizer_id: organiser,
      organizer_org_id: org.id,
      latitude: FENCE.lat,
      longitude: FENCE.lng,
      geofence: FENCE,
      venue_id: venue.id,
      venue_link_status: link,
      door_policy: "guest_list",
      min_age: 21,
    },
  })
  events.push(event.id)
  const user = await db.user.findUniqueOrThrow({ where: { id: organiser }, select: { email: true } })
  return { event, token: signAccessToken(organiser, user.email), venueId: venue.id }
}

async function clone(eventId: string, token: string) {
  const req = new NextRequest(`http://localhost/api/mobile/events/${eventId}/clone`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  })
  const res = await cloneRoute.POST(req, { params: Promise.resolve({ eventId }) })
  const body = (await res.json()) as { success: boolean; data?: { id: string } }
  expect(res.status).toBe(201)
  events.push(body.data!.id)
  return db.events.findUniqueOrThrow({
    where: { id: body.data!.id },
    select: { geofence: true, venue_id: true, venue_link_status: true, door_policy: true, min_age: true, status: true },
  })
}

it("copies the fence, the door policy and the age floor, and re-links the venue", async () => {
  const { event, token, venueId } = await organiserWithEvent("auto_linked")
  const copy = await clone(event.id, token)
  expect(copy.status).toBe("draft")
  expect(copy.geofence).toEqual(FENCE)
  expect(copy.door_policy).toBe("guest_list")
  expect(copy.min_age).toBe(21)
  expect(copy.venue_id).toBe(venueId)
  expect(copy.venue_link_status).toBe("auto_linked")
})

it("does not carry a disputed link onto the copy", async () => {
  // The venue owner said "not mine" once; the copy is a fresh link they can
  // dispute again, not one that arrives already disputed.
  const { event, token, venueId } = await organiserWithEvent("disputed")
  const copy = await clone(event.id, token)
  expect(copy.venue_id).toBe(venueId)
  expect(copy.venue_link_status).toBe("auto_linked")
})
