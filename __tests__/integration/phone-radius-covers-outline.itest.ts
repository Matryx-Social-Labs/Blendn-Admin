import { NextRequest } from "next/server"
import { signAccessToken } from "@/lib/mobile-auth"
import { haversineDistanceMeters } from "@/lib/geo"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as
  typeof import("@/app/api/mobile/events/[eventId]/route")

/*
 * SCRUM-350. The app judges the area as `checkInRadius` metres around the pin
 * (the check-in button, PresenceMonitor). An outline's event stored whatever
 * radius the form last had — the Chinnaswamy outline, ~260 m across, stored
 * 60 and 100 on staging — so a phone inside the stadium read as outside.
 */

const users: string[] = []
const events: string[] = []
const venues: string[] = []

afterAll(async () => {
  await db.events.updateMany({ where: { id: { in: events } }, data: { venue_id: null } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

const pin = { lat: 12.97886, lng: 77.5995 }
const d = 0.0012
const stadium = {
  type: "polygon",
  buffer: 20,
  ring: [
    [pin.lat - d, pin.lng - d],
    [pin.lat - d, pin.lng + d],
    [pin.lat + d, pin.lng + d],
    [pin.lat + d, pin.lng - d],
  ],
}
const coversStadium = Math.max(
  ...stadium.ring.map(([lat, lng]) => haversineDistanceMeters(pin.lat, pin.lng, lat, lng))
) + stadium.buffer

async function attendeeToken() {
  const id = await makeUser("phone-radius", "attendee")
  users.push(id)
  const dob = new Date()
  dob.setFullYear(dob.getFullYear() - 25)
  await db.profiles.create({ data: { id, name: "Test phone radius", date_of_birth: dob, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return signAccessToken(id, email)
}

async function hostedEvent(data: Parameters<typeof db.events.update>[0]["data"]) {
  const host = await makeUser("phone-radius-host", "organizer")
  users.push(host)
  const id = await makeEvent(host)
  events.push(id)
  await db.events.update({ where: { id }, data: { latitude: pin.lat, longitude: pin.lng, ...data } })
  return id
}

async function checkInRadius(eventId: string, token: string) {
  const res = await eventRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ eventId }) }
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { checkInRadius: number } }
  return body.data.checkInRadius
}

describe("the mobile event detail's checkInRadius covers the check-in area", () => {
  it("covers an event's own outline, not the 100 m it stored", async () => {
    const token = await attendeeToken()
    const eventId = await hostedEvent({ geofence: stadium, check_in_radius: 100 })
    expect(await checkInRadius(eventId, token)).toBeGreaterThanOrEqual(coversStadium)
  })

  it("covers the venue's outline when the event inherits it", async () => {
    const token = await attendeeToken()
    const venue = await db.venues.create({
      data: { name: testId("venue"), latitude: pin.lat, longitude: pin.lng, geofence: stadium },
      select: { id: true },
    })
    venues.push(venue.id)
    const eventId = await hostedEvent({ venue: { connect: { id: venue.id } }, check_in_radius: 30 })
    expect(await checkInRadius(eventId, token)).toBeGreaterThanOrEqual(coversStadium)
  })

  it("leaves a pin-and-radius event's radius as it was", async () => {
    const token = await attendeeToken()
    const eventId = await hostedEvent({ check_in_radius: 100 })
    expect(await checkInRadius(eventId, token)).toBe(100)
  })
})
