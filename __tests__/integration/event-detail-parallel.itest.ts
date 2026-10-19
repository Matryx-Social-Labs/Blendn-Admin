import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { db, cleanup, closeDb, makeUser, makeEvent, testId } from "./helpers"
import { laggedDb } from "./lagged-db"

/**
 * GET /events/:id asked for the event, THEN the headcount, THEN everything else:
 * three waits in series. Every operation is held 60 ms here, so what runs side by
 * side overlaps and what runs in series is a lag apart.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const detailRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")

const lag = laggedDb(60)
const users: string[] = []
let eventId: string
let token: string

beforeAll(async () => {
  const organiser = await makeUser(testId("dpar_org"), "organizer")
  const viewer = await makeUser(testId("dpar_viewer"))
  users.push(organiser, viewer)
  await db.profiles.create({ data: { id: viewer, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  token = signAccessToken(viewer, email)
  eventId = await makeEvent(organiser)
  lag.install()
})

afterAll(async () => {
  await lag.restore()
  await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
  await cleanup(users, [eventId])
  await closeDb()
})

it("reads the event, the headcount and the viewer's own rows side by side", async () => {
  lag.reset()
  const res = await detailRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ eventId }) }
  )
  expect(res.status).toBe(200)

  // The first events.findUnique is the access check (attendeeEventAccess); the second is the page's own read.
  expect(lag.overlap("events.findUnique", "event_favorites.findUnique", 1)).toBe(true)
  expect(lag.overlap("events.findUnique", "event_occurrences.findMany", 1)).toBe(true)
  expect(lag.overlap("events.findUnique", "event_check_ins.findFirst", 1)).toBe(true)
  // Blocklist, access check, the page's reads, and the headcount's own second step: 3-4 waits, not 6.
  expect(lag.waves()).toBeLessThanOrEqual(4)
})
