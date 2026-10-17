import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { db, cleanup, closeDb, makeUser, makeEvent, occurrenceOf, testId } from "./helpers"

/**
 * "Here now" is who is inside: a checked-out row is not counted.
 *
 * Final drive: Evening Ragas' live card read "14 here now" with 12 checked in.
 * The card read the attended count (`checkInCount` / `currentCapacity`), which
 * keeps everybody who has left — on purpose, so a night's headline does not
 * fall. `hereCount` is the Room's number, on the list and the detail.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const detailRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")

const users: string[] = []
const CITY = `Qahere${testId("c").replace(/[^a-z0-9]/gi, "").slice(-8)}`
let eventId: string
let auth: string

beforeAll(async () => {
  const organiser = await makeUser(testId("here_org"), "organizer")
  const viewer = await makeUser(testId("here_viewer"))
  users.push(organiser, viewer)
  await db.profiles.create({ data: { id: viewer, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  auth = signAccessToken(viewer, email)

  eventId = await makeEvent(organiser)
  await db.events.update({ where: { id: eventId }, data: { city: CITY, curated_at: new Date() } })
  const occurrenceId = await occurrenceOf(eventId)

  const statuses = ["checked_in", "checked_in", "checked_in", "checked_out", "checked_out"] as const
  for (const [i, status] of statuses.entries()) {
    const id = await makeUser(testId(`here_${i}`))
    users.push(id)
    await db.event_check_ins.create({
      data: {
        event_id: eventId,
        occurrence_id: occurrenceId,
        user_id: id,
        status,
        check_in_time: new Date(Date.now() - 30 * 60_000),
        ...(status === "checked_out" && { check_out_time: new Date() }),
      },
    })
  }
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
  await cleanup(users, [eventId])
  await closeDb()
})

const get = (route: { GET: (...a: never[]) => Promise<Response> }, url: string, params?: object) =>
  (route.GET as (req: NextRequest, ctx?: object) => Promise<Response>)(
    new NextRequest(url, { headers: { authorization: `Bearer ${auth}` } }),
    params
  )

it("the list's hereCount leaves out who checked out; checkInCount still counts who came", async () => {
  const res = await get(eventsRoute, `http://localhost/api/mobile/events?limit=11&city=${encodeURIComponent(CITY)}`)
  expect(res.status).toBe(200)
  const events = (await res.json()).data.events as { id: string; hereCount: number; checkInCount: number }[]
  const card = events.find((e) => e.id === eventId)
  expect(card?.hereCount).toBe(3)
  expect(card?.checkInCount).toBe(5)
})

it("the detail's stats say the same", async () => {
  const res = await get(detailRoute, `http://localhost/api/mobile/events/${eventId}`, { params: Promise.resolve({ eventId }) })
  expect(res.status).toBe(200)
  const { stats } = (await res.json()).data
  expect(stats.hereCount).toBe(3)
  expect(stats.checkInCount).toBe(5)
})
