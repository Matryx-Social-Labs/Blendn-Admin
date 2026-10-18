import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { db, cleanup, closeDb, makeUser, makeEvent, testId } from "./helpers"
import { recordStatements, shape } from "./statements"

/**
 * The event list and the event detail carry favoriteCount, ratingCount and the
 * going count. They were Prisma relation `_count`s, which the query engine emits
 * as a LEFT JOIN onto `SELECT event_id, COUNT(*) FROM <table> WHERE 1=1 GROUP BY
 * event_id`: every row of event_rsvps, event_favorites and event_ratings read
 * and hashed per call, to answer for one page. The numbers must not move; the
 * statements must stop scanning the world.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const listRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const detailRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")

const users: string[] = []
const CITY = `Qatally${testId("c").replace(/[^a-z0-9]/gi, "").slice(-8)}`
let eventId: string
let auth: string

// The whole-table shape `_count` emitted: a GROUP BY with no restriction on event_id.
const WHOLE_TABLE_AGGREGATE = /WHERE 1=1\s+GROUP BY/i

beforeAll(async () => {
  const organiser = await makeUser(testId("tally_org"), "organizer")
  const viewer = await makeUser(testId("tally_viewer"))
  users.push(organiser, viewer)
  await db.profiles.create({ data: { id: viewer, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  auth = signAccessToken(viewer, email)

  eventId = await makeEvent(organiser)
  await db.events.update({ where: { id: eventId }, data: { city: CITY, curated_at: new Date() } })

  const rsvps = ["going", "going", "going", "waitlisted", "maybe", "not_going"] as const
  for (const [i, status] of rsvps.entries()) {
    const id = await makeUser(testId(`tally_${i}`))
    users.push(id)
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: id, status } })
    if (i < 4) await db.event_favorites.create({ data: { event_id: eventId, user_id: id } })
    if (i < 2) await db.event_ratings.create({ data: { event_id: eventId, user_id: id, rating: 4 } })
  }
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
  await cleanup(users, [eventId])
  await closeDb()
})

const get = (url: string) =>
  new NextRequest(`http://localhost${url}`, { headers: { authorization: `Bearer ${auth}` } })

it("the list gives the same counts, from statements that name the page's events", async () => {
  const { result: res, statements } = await recordStatements(() =>
    listRoute.GET(get(`/api/mobile/events?limit=9&city=${encodeURIComponent(CITY)}`))
  )
  expect(res.status).toBe(200)
  const row = ((await res.json()).data.events as Record<string, number | string>[]).find(
    (e) => e.id === eventId
  )
  expect(row).toMatchObject({ favoriteCount: 4, ratingCount: 2, goingCount: 3 })
  console.log("list:", shape(statements))
  expect(statements.filter((s) => WHOLE_TABLE_AGGREGATE.test(s.sql)).length).toBe(0)
})

it("the detail gives the same counts, from statements that name the event", async () => {
  const { result: res, statements } = await recordStatements(() =>
    detailRoute.GET(get(`/api/mobile/events/${eventId}`), { params: Promise.resolve({ eventId }) })
  )
  expect(res.status).toBe(200)
  expect((await res.json()).data.stats).toMatchObject({ favoriteCount: 4, ratingCount: 2, rsvpCount: 3 })
  console.log("detail:", shape(statements))
  expect(statements.filter((s) => WHOLE_TABLE_AGGREGATE.test(s.sql)).length).toBe(0)
})
