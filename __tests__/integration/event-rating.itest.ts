import { NextRequest } from "next/server"

/*
 * Rating an event you went to (SCRUM-150 / SCRUM-181).
 *
 * The route required `event_check_ins.status === "checked_in"` — presence,
 * not attendance. Leaving the venue, or the sweeper's auto-checkout at the end
 * of the night, flips that to `checked_out`, so the moment a rating is for
 * was the moment it was refused. On staging: 48 of 48 past check-ins were
 * `checked_out`; `event_ratings` had never received a row.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ratingRoute = require("@/app/api/mobile/events/[eventId]/rating/route") as
  typeof import("@/app/api/mobile/events/[eventId]/rating/route")

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as
  typeof import("@/app/api/mobile/events/[eventId]/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  await db.event_ratings.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label), "attendee")
  users.push(id)
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, user.email) }
}

const rate = (token: string, eventId: string, body: unknown) =>
  ratingRoute.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/rating`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ eventId }) }
  )

const detail = async (token: string, eventId: string) => {
  const res = await eventRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ eventId }) }
  )
  expect(res.status).toBe(200)
  return (await res.json()).data as { stats: { ratingCount: number } }
}

describe("rating an event", () => {
  let host: string
  beforeAll(async () => {
    host = await makeUser(testId("rate-host"), "organizer")
    users.push(host)
  })

  /** An event that ended `hoursAgo` hours ago (negative = still on). */
  async function eventEnded(hoursAgo: number) {
    const id = await makeEvent(host)
    events.push(id)
    const end = new Date(Date.now() - hoursAgo * HOUR)
    await db.events.update({
      where: { id },
      data: { start_time: new Date(end.getTime() - 3 * HOUR), end_time: end },
    })
    return id
  }

  it("is open to someone who attended and has since left — attendance, not presence", async () => {
    const eventId = await eventEnded(2)
    const fan = await person("rate-fan")
    await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId: fan.id })
    // Left at the end of the night, the way everyone does.
    await db.event_check_ins.updateMany({
      where: { event_id: eventId, user_id: fan.id },
      data: { status: "checked_out", check_out_time: new Date() },
    })

    const res = await rate(fan.token, eventId, { rating: 4, review: "long bar queue" })
    expect(res.status).toBe(200)
    // A count and no average: one rating is this person's score (SCRUM-437).
    const body = await res.json()
    expect(body.data.eventStats).toEqual({ ratingCount: 1 })

    // Rating again edits the one row rather than adding a second.
    const again = await rate(fan.token, eventId, { rating: 5 })
    expect(again.status).toBe(200)
    const rows = await db.event_ratings.findMany({ where: { event_id: eventId, user_id: fan.id } })
    expect(rows.map((r) => r.rating)).toEqual([5])
  })

  it("never hands an attendee an average, at any count: polled, it reads each new score (SCRUM-437)", async () => {
    const eventId = await eventEnded(2)
    const occurrenceId = await occurrenceOf(eventId)
    const fans = await Promise.all([1, 2, 3, 4, 5].map((n) => person(`rate-crowd${n}`)))
    for (const fan of fans) await putInRoom({ eventId, occurrenceId, userId: fan.id })

    for (const [i, fan] of fans.entries()) {
      const reply = await rate(fan.token, eventId, { rating: [5, 4, 4, 3, 5][i] })
      expect((await reply.json()).data.eventStats).toEqual({ ratingCount: i + 1 })
      const stats = (await detail(fans[0].token, eventId)).stats
      expect(stats.ratingCount).toBe(i + 1)
      expect(stats).not.toHaveProperty("averageRating")
    }
  })

  it("refuses someone who never checked in", async () => {
    const eventId = await eventEnded(2)
    const stranger = await person("rate-stranger")
    const res = await rate(stranger.token, eventId, { rating: 1 })
    expect(res.status).toBe(403)
    expect(await db.event_ratings.count({ where: { event_id: eventId } })).toBe(0)
  })

  it("refuses a rating while the event is still on (negative control for the end rule)", async () => {
    const eventId = await eventEnded(-1)
    const fan = await person("rate-early")
    await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId: fan.id })
    const res = await rate(fan.token, eventId, { rating: 5 })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: "You can rate this event once it has ended" })
    expect(await db.event_ratings.count({ where: { event_id: eventId } })).toBe(0)
  })
})
