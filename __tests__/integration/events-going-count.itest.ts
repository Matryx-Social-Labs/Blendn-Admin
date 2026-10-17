import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { db, cleanup, closeDb, makeUser, makeEvent, testId } from "./helpers"

/**
 * The events list carries `goingCount`, so a card (the Pulse) need not open
 * every event's detail to show it. Going only: a waitlisted, maybe or
 * not-going RSVP is not somebody going.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")

const users: string[] = []
const CITY = `Qagoing${testId("c").replace(/[^a-z0-9]/gi, "").slice(-8)}`
let eventId: string
let auth: string

beforeAll(async () => {
  const organiser = await makeUser(testId("going_org"), "organizer")
  const viewer = await makeUser(testId("going_viewer"))
  users.push(organiser, viewer)
  await db.profiles.create({ data: { id: viewer, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  auth = signAccessToken(viewer, email)

  eventId = await makeEvent(organiser)
  await db.events.update({ where: { id: eventId }, data: { city: CITY, curated_at: new Date() } })

  const statuses = ["going", "going", "waitlisted", "maybe", "not_going"] as const
  for (const [i, status] of statuses.entries()) {
    const id = await makeUser(testId(`going_${i}`))
    users.push(id)
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: id, status } })
  }
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
  await cleanup(users, [eventId])
  await closeDb()
})

it("each event carries goingCount: going RSVPs only, not waitlisted, maybe or not going", async () => {
  const res = await eventsRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events?limit=9&city=${encodeURIComponent(CITY)}`, {
      headers: { authorization: `Bearer ${auth}` },
    })
  )
  expect(res.status).toBe(200)
  const events = (await res.json()).data.events as { id: string; goingCount: number }[]
  expect(events.find((e) => e.id === eventId)?.goingCount).toBe(2)
})
