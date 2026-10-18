import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { db, cleanup, closeDb, makeUser, makeEvent, testId } from "./helpers"
import { recordStatements, shape, type Statement } from "./statements"

/**
 * On a cache hit the list route has nothing left to ask about the events, only
 * about the viewer and the counts. The favourites, check-ins and profile reads
 * ran first and the attended / here-now / tally counts after them, so a hit
 * still cost two sequential waves. They are independent: one wave.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const listRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")

const users: string[] = []
const CITY = `Qahit${testId("c").replace(/[^a-z0-9]/gi, "").slice(-8)}`
let eventId: string
let auth: string

const overlap = (a: Statement, b: Statement) => a.start < b.end && b.start < a.end

beforeAll(async () => {
  const organiser = await makeUser(testId("hit_org"), "organizer")
  const viewer = await makeUser(testId("hit_viewer"))
  users.push(organiser, viewer)
  await db.profiles.create({ data: { id: viewer, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  auth = signAccessToken(viewer, email)
  eventId = await makeEvent(organiser)
  await db.events.update({ where: { id: eventId }, data: { city: CITY, curated_at: new Date() } })
  await db.event_favorites.create({ data: { event_id: eventId, user_id: viewer } })
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
  await cleanup(users, [eventId])
  await closeDb()
})

it("a cache hit asks for the viewer's favourites and the page's counts in one wave", async () => {
  const get = () =>
    listRoute.GET(
      new NextRequest(`http://localhost/api/mobile/events?limit=9&city=${encodeURIComponent(CITY)}`, {
        headers: { authorization: `Bearer ${auth}` },
      })
    )
  expect((await get()).status).toBe(200) // fills the cache

  const { result: res, statements } = await recordStatements(get)
  const body = (await res.json()).data.events as { id: string; isFavorited: boolean }[]
  expect(body.find((e) => e.id === eventId)?.isFavorited).toBe(true)
  console.log("cache hit:", shape(statements))

  // The event list itself is not read again: a hit.
  expect(statements.some((s) => /FROM "public"\."events"/.test(s.sql) && /LIMIT/.test(s.sql))).toBe(false)
  const favourites = statements.find((s) => /FROM "public"\."event_favorites"/.test(s.sql) && /"user_id"/.test(s.sql) && !/GROUP BY/.test(s.sql))!
  const attended = statements.find((s) => /COUNT\(DISTINCT user_id\)/.test(s.sql))!
  expect(favourites && attended).toBeTruthy()
  expect(overlap(favourites, attended)).toBe(true)
})
