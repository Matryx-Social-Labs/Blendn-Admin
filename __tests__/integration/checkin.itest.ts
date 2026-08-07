import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is pure ESM with no CommonJS build, and `lib/mobile-auth.ts` imports it
// at module scope for Google OAuth verification. Jest cannot load it, and none
// of these tests touch Google — `signAccessToken` uses `jsonwebtoken`. Stubbed
// so the real token signer can be imported rather than a second JWT format
// hand-rolled here, which would drift the day the real one changes.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { getOccupancy } from "@/lib/occupancy"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * The check-in route, driven end to end.
 *
 * This is the mechanic the entire product rests on, and until now **no test
 * invoked it**. Two of seventy-four route files had integration coverage, which
 * is how a capacity bug shipped twice in one day and how the RSC boundary break
 * reached production.
 *
 * Everything here goes through the real handler with a real JWT against real
 * Postgres. No mocks.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as
  typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkoutRoute = require("@/app/api/mobile/events/[eventId]/checkout/route") as
  typeof import("@/app/api/mobile/events/[eventId]/checkout/route")

const users: string[] = []
const events: string[] = []
const orgs: string[] = []

/** Bengaluru, and the fence below is centred on it. */
const LAT = 12.9784
const LNG = 77.6408

afterAll(async () => {
  if (events.length) {
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (orgs.length) {
    await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
    await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function liveEvent(opts: { capacity?: number | null; orgId?: string } = {}) {
  const owner = await makeUser(testId("ci_own"), "organizer")
  users.push(owner)

  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("ci"),
      title: "Check-in fixture",
      description: "integration fixture",
      // Already started, ends in two hours: the check-in window is open.
      start_time: new Date(now - 30 * 60_000),
      end_time: new Date(now + 2 * 60 * 60_000),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: owner,
      organizer_org_id: opts.orgId ?? null,
      max_capacity: opts.capacity ?? null,
      latitude: LAT,
      longitude: LNG,
      geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 },
    },
  })
  events.push(event.id)

  await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
  })
  return event.id
}

async function attendee(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, user.email) }
}

function checkInRequest(
  eventId: string,
  token: string,
  body: Record<string, unknown> = {}
) {
  return new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ latitude: LAT, longitude: LNG, ...body }),
  })
}

const doCheckIn = (eventId: string, token: string, body?: Record<string, unknown>) =>
  checkinRoute.POST(checkInRequest(eventId, token, body), {
    params: Promise.resolve({ eventId }),
  })

const doCheckOut = (eventId: string, token: string) =>
  checkoutRoute.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ eventId }) }
  )

describe("check-in", () => {
  it("checks someone in and counts them", async () => {
    const eventId = await liveEvent()
    const ada = await attendee("ada")

    const res = await doCheckIn(eventId, ada.token)
    expect(res.status).toBe(200)
    expect((await getOccupancy(eventId)).inside).toBe(1)
  })

  it("refuses someone outside the fence", async () => {
    // ~2km away. The fence is 60m + 20m buffer.
    const eventId = await liveEvent()
    const bo = await attendee("bo")
    const res = await doCheckIn(eventId, bo.token, { latitude: LAT + 0.02, longitude: LNG })
    expect(res.status).toBe(400)
    expect((await getOccupancy(eventId)).inside).toBe(0)
  })

  it("refuses an unauthenticated caller", async () => {
    const eventId = await liveEvent()
    const res = await checkinRoute.POST(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ latitude: LAT, longitude: LNG }),
      }),
      { params: Promise.resolve({ eventId }) }
    )
    expect(res.status).toBe(401)
  })
})

describe("capacity does not gate check-in", () => {
  it("lets the queue in past the stated capacity", async () => {
    // THE case. The geofence covers the pavement, so people queuing outside are
    // legitimately within it. Refusing them denied the chatroom and erased them
    // from attendance.
    const eventId = await liveEvent({ capacity: 2 })
    for (const label of ["q1", "q2", "q3"]) {
      const person = await attendee(label)
      const res = await doCheckIn(eventId, person.token)
      expect(res.status).toBe(200)
    }

    const occ = await getOccupancy(eventId)
    expect(occ.inside).toBe(3)
    expect(occ.overCapacity).toBe(true)
  })
})

describe("re-entry", () => {
  it("comes back to the same count after a checkout and return", async () => {
    // The v0.40.1 regression, driven through the real routes: with a stored
    // counter, checkout decremented and re-entry did not increment, so every
    // smoke break permanently undercounted the room.
    const eventId = await liveEvent({ capacity: 100 })
    const smoker = await attendee("smoker")

    await doCheckIn(eventId, smoker.token)
    expect((await getOccupancy(eventId)).inside).toBe(1)

    expect((await doCheckOut(eventId, smoker.token)).status).toBe(200)
    expect((await getOccupancy(eventId)).inside).toBe(0)

    await doCheckIn(eventId, smoker.token)
    expect((await getOccupancy(eventId)).inside).toBe(1)

    // One person, however many times they went in and out.
    expect((await getOccupancy(eventId)).uniqueAttendance).toBe(1)
  })

  it("checking in twice without leaving does not double-count", async () => {
    const eventId = await liveEvent({ capacity: 100 })
    const keen = await attendee("keen")
    await doCheckIn(eventId, keen.token)
    await doCheckIn(eventId, keen.token)
    expect((await getOccupancy(eventId)).inside).toBe(1)
  })
})

describe("switching events", () => {
  it("closes the previous room when you check in somewhere else", async () => {
    const first = await liveEvent({ capacity: 100 })
    const second = await liveEvent({ capacity: 100 })
    const wanderer = await attendee("wanderer")

    await doCheckIn(first, wanderer.token)
    expect((await getOccupancy(first)).inside).toBe(1)

    await doCheckIn(second, wanderer.token)

    // You cannot be in two rooms.
    expect((await getOccupancy(first)).inside).toBe(0)
    expect((await getOccupancy(second)).inside).toBe(1)
  })

  it("leaves the first event's attendance intact — they did attend", async () => {
    const first = await liveEvent()
    const second = await liveEvent()
    const person = await attendee("both")

    await doCheckIn(first, person.token)
    await doCheckIn(second, person.token)

    // Occupancy went to zero, but they were there.
    expect((await getOccupancy(first)).uniqueAttendance).toBe(1)
  })
})

describe("staff are told apart, with no client change", () => {
  it("marks the organising org's people as staff and keeps them out of attendance", async () => {
    const org = await db.organisations.create({
      data: { display_name: `Test Org ${testId("o")}` },
    })
    orgs.push(org.id)

    const eventId = await liveEvent({ capacity: 100, orgId: org.id })
    const crew = await attendee("crew")
    await db.organisation_members.create({
      data: { org_id: org.id, user_id: crew.id, role: "owner" },
    })
    const guest = await attendee("guest")

    // Identical requests. The client sends nothing about roles.
    await doCheckIn(eventId, crew.token)
    await doCheckIn(eventId, guest.token)

    const occ = await getOccupancy(eventId)
    expect(occ.inside).toBe(2) // fire safety counts bodies
    expect(occ.staffInside).toBe(1)
    expect(occ.uniqueAttendance).toBe(1) // the business number does not
  })
})
