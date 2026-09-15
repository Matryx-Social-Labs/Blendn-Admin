import { NextRequest } from "next/server"

/*
 * One event, reached by id, by somebody discovery would not have shown it to.
 *
 * Found by driving sign-up on Android as a 17-year-old against staging
 * (SCRUM-130): the feed hid the 18+ event and the door refused them, and every
 * other single-event route let them in — GET, RSVP, favourite, the board. A
 * draft could be RSVP'd to the same way (SCRUM-13 closed the feed only). This
 * posts the real routes and reads the rows, because the rule now lives in one
 * resolver and the way it regresses is a route that stops calling it.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as
  typeof import("@/app/api/mobile/events/[eventId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rsvpRoute = require("@/app/api/mobile/events/[eventId]/rsvp/route") as
  typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const favoriteRoute = require("@/app/api/mobile/events/[eventId]/favorite/route") as
  typeof import("@/app/api/mobile/events/[eventId]/favorite/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as
  typeof import("@/app/api/mobile/events/[eventId]/board/route")

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.event_favorites.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string, dateOfBirth: Date | null) {
  const id = await makeUser(label)
  users.push(id)
  await db.profiles.create({ data: { id, name: `Test ${label}`, date_of_birth: dateOfBirth } })
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, user.email) }
}

const yearsAgo = (n: number) => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - n)
  return d
}

const req = (method: "GET" | "POST", url: string, token: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const params = (eventId: string) => ({ params: Promise.resolve({ eventId }) })

/** Every attendee route that takes one event id, as the given person. */
async function everyRoute(eventId: string, token: string) {
  const [get, rsvp, favorite, board] = await Promise.all([
    eventRoute.GET(req("GET", `/api/mobile/events/${eventId}`, token), params(eventId)),
    rsvpRoute.POST(req("POST", `/api/mobile/events/${eventId}/rsvp`, token, { status: "going" }), params(eventId)),
    favoriteRoute.POST(req("POST", `/api/mobile/events/${eventId}/favorite`, token), params(eventId)),
    boardRoute.GET(req("GET", `/api/mobile/events/${eventId}/board`, token), params(eventId)),
  ])
  return { get: get.status, rsvp: rsvp.status, favorite: favorite.status, board: board.status }
}

describe("an 18+ event reached by id", () => {
  let host: string
  let eventId: string

  beforeAll(async () => {
    host = await makeUser("ea-host", "organizer")
    users.push(host)
    eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { min_age: 18 } })
  })

  it("refuses a 17-year-old everywhere, with the door's code, and writes nothing", async () => {
    const minor = await person("ea-minor", yearsAgo(17))

    const get = await eventRoute.GET(req("GET", `/api/mobile/events/${eventId}`, minor.token), params(eventId))
    expect(get.status).toBe(403)
    expect(await get.json()).toMatchObject({ errorCode: "AGE_RESTRICTED", error: "This event is 18+." })

    expect(await everyRoute(eventId, minor.token)).toEqual({ get: 403, rsvp: 403, favorite: 403, board: 403 })
    expect(await db.event_rsvps.count({ where: { event_id: eventId, user_id: minor.id } })).toBe(0)
    expect(await db.event_favorites.count({ where: { event_id: eventId, user_id: minor.id } })).toBe(0)
  })

  it("lets a 30-year-old in (negative control for the rule)", async () => {
    const adult = await person("ea-adult", yearsAgo(30))
    const r = await everyRoute(eventId, adult.token)
    expect([r.get, r.rsvp, r.favorite]).toEqual([200, 200, 200])
    expect(await db.event_rsvps.count({ where: { event_id: eventId, user_id: adult.id } })).toBe(1)
  })

  it("shows an account with no age the event and refuses it a seat — discovery's posture, then the door's", async () => {
    const unknown = await person("ea-unknown", null)
    const r = await everyRoute(eventId, unknown.token)
    expect(r.get).toBe(200)
    expect([r.rsvp, r.favorite, r.board]).toEqual([403, 403, 403])
  })

  it("is open to everyone once the restriction is lifted (negative control for the guard)", async () => {
    await db.events.update({ where: { id: eventId }, data: { min_age: null } })
    const minor = await person("ea-minor-2", yearsAgo(17))
    const r = await everyRoute(eventId, minor.token)
    expect([r.get, r.rsvp, r.favorite]).toEqual([200, 200, 200])
  })
})

describe("events discovery would never list", () => {
  it("a draft reads as not found on every route, so an id is not a way to learn it exists", async () => {
    const host = await makeUser("ea-draft-host", "organizer")
    users.push(host)
    const draft = await makeEvent(host)
    events.push(draft)
    await db.events.update({ where: { id: draft }, data: { status: "draft" } })
    const someone = await person("ea-someone", yearsAgo(30))

    expect(await everyRoute(draft, someone.token)).toEqual({ get: 404, rsvp: 404, favorite: 404, board: 404 })
    expect(await db.event_rsvps.count({ where: { event_id: draft } })).toBe(0)
  })

  it("a private event is not found for a stranger and open to someone on the list", async () => {
    const host = await makeUser("ea-private-host", "organizer")
    users.push(host)
    const priv = await makeEvent(host, { visibility: "private" })
    events.push(priv)
    const stranger = await person("ea-stranger", yearsAgo(30))
    const invited = await person("ea-invited", yearsAgo(30))
    await db.event_rsvps.create({ data: { event_id: priv, user_id: invited.id, status: "maybe" } })

    expect((await everyRoute(priv, stranger.token)).get).toBe(404)
    expect((await everyRoute(priv, invited.token)).get).toBe(200)
  })
})
