import { NextRequest } from "next/server"

/*
 * `days` on the event detail (SV1): the run, day by day, with a cancelled day
 * marked, and a bounded window with the whole count for a very long run.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { EVENT_DAYS_WINDOW } from "@/lib/occurrences"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as
  typeof import("@/app/api/mobile/events/[eventId]/route")

const users: string[] = []
const events: string[] = []
const DAY = 24 * 60 * 60 * 1000
afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function detail(eventId: string, token: string) {
  const res = await eventRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ eventId }) }
  )
  expect(res.status).toBe(200)
  return (await res.json()).data as {
    session: { startTime: string; endTime: string } | null
    days: { date: string; startTime: string; endTime: string; cancelled: boolean; cancelledAt: string | null }[]
    dayCount: number
    daysFrom: number
  }
}

/** An event whose days are `n` consecutive 8-hour days, the first `daysAgo` days ago. */
async function run(host: string, n: number, daysAgo: number, cancel: number[] = []) {
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
  const first = Date.now() - daysAgo * DAY
  const rows = Array.from({ length: n }, (_, i) => {
    const start = new Date(first + i * DAY)
    return {
      event_id: eventId,
      occurs_on: new Date(start.toISOString().slice(0, 10)),
      start_time: start,
      end_time: new Date(start.getTime() + 8 * 60 * 60 * 1000),
      cancelled_at: cancel.includes(i) ? new Date() : null,
    }
  })
  await db.event_occurrences.createMany({ data: rows })
  await db.events.update({
    where: { id: eventId },
    data: { start_time: rows[0].start_time, end_time: rows[n - 1].end_time },
  })
  return eventId
}

it("lists a three-day festival with its cancelled day marked, beside session", async () => {
  const host = await makeUser(testId("days-host"), "organizer")
  users.push(host)
  const viewer = await makeUser(testId("days-viewer"))
  users.push(viewer)
  const token = signAccessToken(viewer, `${viewer}@itest.invalid`)

  const eventId = await run(host, 3, 1, [2])
  const body = await detail(eventId, token)

  expect(body.dayCount).toBe(3)
  expect(body.daysFrom).toBe(1)
  expect(body.days.map((d) => d.cancelled)).toEqual([false, false, true])
  expect(body.days.map((d) => d.cancelledAt !== null)).toEqual([false, false, true])
  expect(Object.keys(body.days[0]).sort()).toEqual(["cancelled", "cancelledAt", "date", "endTime", "startTime"])
  // session is still the day the app talks about (day 2, running or next), never the cancelled one.
  expect(body.session!.startTime).toBe(body.days[1].startTime)
})

it("is one day for an ordinary single-day event", async () => {
  const host = await makeUser(testId("days-host1"), "organizer")
  users.push(host)
  const viewer = await makeUser(testId("days-viewer1"))
  users.push(viewer)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const body = await detail(eventId, signAccessToken(viewer, `${viewer}@itest.invalid`))
  expect(body.dayCount).toBe(1)
  expect(body.days).toHaveLength(1)
  expect(body.days[0]).toMatchObject({ cancelled: false, cancelledAt: null })
})

it("caps a 120-day run at a window around today and still says 120", async () => {
  const host = await makeUser(testId("days-hostL"), "organizer")
  users.push(host)
  const viewer = await makeUser(testId("days-viewerL"))
  users.push(viewer)
  const eventId = await run(host, 120, 60) // today is about day 61
  const body = await detail(eventId, signAccessToken(viewer, `${viewer}@itest.invalid`))

  expect(body.dayCount).toBe(120)
  expect(body.days).toHaveLength(EVENT_DAYS_WINDOW)
  const at = body.days.findIndex((d) => d.startTime === body.session!.startTime)
  expect(at).toBeGreaterThanOrEqual(0)
  // Two days of lead, and `daysFrom` says where the window starts in the run.
  expect(at).toBe(2)
  expect(body.daysFrom).toBeGreaterThan(1)
})
