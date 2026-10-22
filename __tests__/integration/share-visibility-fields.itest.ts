import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"

/**
 * The fields the app's cards need to say "unlisted" and the event screen needs
 * to name a neighbourhood (Flow 16, batch A2). Read through the real routes.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const listRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rsvpsRoute = require("@/app/api/mobile/me/rsvps/route") as typeof import("@/app/api/mobile/me/rsvps/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const favoritesRoute = require("@/app/api/mobile/users/[userId]/favorites/route") as typeof import("@/app/api/mobile/users/[userId]/favorites/route")

const CITY = `Qaarea${testId("c").replace(/[^a-z0-9]/gi, "").slice(-8)}`
const users: string[] = []
const eventIds: string[] = []
let viewer: string
let auth: string
let publicEvent: string
let unlistedEvent: string
let linkedEvent: string
let venue: string

function authed(path: string) {
  return new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${auth}` } })
}

beforeAll(async () => {
  const organiser = await makeUser("vis_org", "organizer")
  viewer = await makeUser("vis_viewer")
  users.push(organiser, viewer)
  await onboard(viewer)
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  auth = signAccessToken(viewer, email)

  venue = (await db.venues.create({ data: { name: "Area Venue", area: "Indiranagar", city: CITY } })).id
  publicEvent = await makeEvent(organiser)
  unlistedEvent = await makeEvent(organiser, { visibility: "unlisted" })
  linkedEvent = await makeEvent(organiser)
  eventIds.push(publicEvent, unlistedEvent, linkedEvent)
  await db.events.update({ where: { id: publicEvent }, data: { city: CITY, curated_at: new Date() } })
  await db.events.update({ where: { id: unlistedEvent }, data: { city: CITY } })
  await db.events.update({ where: { id: linkedEvent }, data: { city: CITY, venue_id: venue, venue_link_status: "confirmed" } })
  for (const event_id of [publicEvent, unlistedEvent]) {
    await db.event_rsvps.create({ data: { event_id, user_id: viewer, status: "going" } })
    await db.event_favorites.create({ data: { event_id, user_id: viewer } })
  }
})

afterAll(async () => {
  await db.event_favorites.deleteMany({ where: { user_id: viewer } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: eventIds } } })
  await cleanup(users, eventIds)
  await db.venues.deleteMany({ where: { id: venue } })
  await closeDb()
})

type Card = { id: string; visibility: string }

it("GET /me/rsvps carries each event's visibility", async () => {
  const res = await rsvpsRoute.GET(authed("/api/mobile/me/rsvps"))
  const events = (await res.json()).data.events as Card[]
  expect(events.find((e) => e.id === publicEvent)?.visibility).toBe("public")
  expect(events.find((e) => e.id === unlistedEvent)?.visibility).toBe("unlisted")
})

it("GET /users/:id/favorites carries each event's visibility", async () => {
  const res = await favoritesRoute.GET(authed(`/api/mobile/users/${viewer}/favorites`), { params: Promise.resolve({ userId: viewer }) })
  const events = (await res.json()).data.events as Card[]
  expect(events.find((e) => e.id === publicEvent)?.visibility).toBe("public")
  expect(events.find((e) => e.id === unlistedEvent)?.visibility).toBe("unlisted")
})

it("GET /events carries visibility, and lists only public events", async () => {
  const res = await listRoute.GET(authed(`/api/mobile/events?limit=20&city=${encodeURIComponent(CITY)}`))
  const events = (await res.json()).data.events as Card[]
  expect(events.find((e) => e.id === publicEvent)?.visibility).toBe("public")
  expect(events.find((e) => e.id === unlistedEvent)).toBeUndefined()
})

describe("GET /events/:id area", () => {
  const read = async (id: string) => {
    const res = await eventRoute.GET(authed(`/api/mobile/events/${id}`), { params: Promise.resolve({ eventId: id }) })
    expect(res.status).toBe(200)
    return (await res.json()).data as { area: string | null; visibility: string }
  }

  it("is the city when no venue is confirmed", async () => {
    expect((await read(publicEvent)).area).toBe(CITY)
  })

  it("is the confirmed venue's area, not the city", async () => {
    expect((await read(linkedEvent)).area).toBe("Indiranagar")
  })

  it("is the city for an unlisted event too, and says it is unlisted", async () => {
    const detail = await read(unlistedEvent)
    expect(detail.area).toBe(CITY)
    expect(detail.visibility).toBe("unlisted")
  })

  it("is null when neither the venue nor the city is known", async () => {
    await db.events.update({ where: { id: publicEvent }, data: { city: null } })
    expect((await read(publicEvent)).area).toBeNull()
  })
})
