import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { ONE_OPEN_CHECK_IN, openSeatSession } from "@/lib/check-in-core"
import { checkOutOfOtherEvents } from "@/lib/checkout"
import { signAccessToken } from "@/lib/mobile-auth"
import { violatedConstraint } from "@/lib/prisma-errors"

import { cleanup, closeDb, db, makeUser, onboard, putInRoom, testId } from "./helpers"

/**
 * One open check-in per person (SCRUM-705), and a switch that is never silent
 * (SCRUM-635).
 *
 * "One room at a time" was app code: the switch and the new row were two
 * statements, so two doors at once could each switch the other out before
 * either wrote, and both stayed open. The database now holds the rule
 * (`event_check_ins_one_open_per_user`), and the door that loses the race
 * switches again. Every assertion reads the rows back.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")

/** A point nobody else's suite uses, so no other fixture's fence is here. */
const LAT = -33.8688 + Math.random() * 0.01
const LNG = 151.2093 + Math.random() * 0.01

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function person() {
  const id = await makeUser(testId("ooc"))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

/** A published event here, with a fence; `days` occurrences, the last one on now. */
async function event(title: string, days: { startMin: number; endMin: number }[] = [{ startMin: -30, endMin: 120 }]) {
  const host = await makeUser(testId("ooc_host"), "organizer")
  users.push(host)
  const at = (min: number) => new Date(Date.now() + min * 60_000)
  const e = await db.events.create({
    data: {
      slug: testId("ooc"),
      title,
      description: "integration fixture",
      start_time: at(days[0].startMin),
      end_time: at(days[days.length - 1].endMin),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: host,
      latitude: LAT,
      longitude: LNG,
      geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 },
    },
  })
  events.push(e.id)
  const occurrences = []
  for (const d of days) {
    occurrences.push(
      await db.event_occurrences.create({
        data: { event_id: e.id, occurs_on: new Date(at(d.startMin).toISOString().slice(0, 10)), start_time: at(d.startMin), end_time: at(d.endMin) },
      })
    )
  }
  return { id: e.id, occurrences: occurrences.map((o) => o.id) }
}

const checkIn = async (eventId: string, token: string) => {
  const res = await checkinRoute.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ latitude: LAT, longitude: LNG }),
    }),
    { params: Promise.resolve({ eventId }) }
  )
  return { status: res.status, json: await res.json() }
}

const openRows = (userId: string) =>
  db.event_check_ins.findMany({ where: { user_id: userId, status: "checked_in" }, select: { event_id: true, occurrence_id: true } })

describe("one open check-in per person", () => {
  it("the database refuses a second open row, by the index's name", async () => {
    const who = await person()
    const a = await event("Room A")
    const b = await event("Room B")
    await putInRoom({ eventId: a.id, occurrenceId: a.occurrences[0], userId: who.id })

    const second = db.event_check_ins.create({
      data: { event_id: b.id, occurrence_id: b.occurrences[0], user_id: who.id, status: "checked_in", check_in_time: new Date() },
    })
    const error = await second.catch((e: unknown) => e)
    expect(violatedConstraint(error, ONE_OPEN_CHECK_IN)).toBe(true)
    // A closed row beside the open one is fine: the rule is about open ones.
    await db.event_check_ins.create({
      data: { event_id: b.id, occurrence_id: b.occurrences[0], user_id: who.id, status: "checked_out", check_in_time: new Date() },
    })
    expect(await openRows(who.id)).toHaveLength(1)
  })

  it("two doors at once leave exactly one open, and both answer", async () => {
    // Several rounds: each is two check-ins for one person landing together.
    for (let round = 0; round < 5; round++) {
      const who = await person()
      const a = await event(`Race A ${round}`)
      const b = await event(`Race B ${round}`)

      const [ra, rb] = await Promise.all([checkIn(a.id, who.token), checkIn(b.id, who.token)])
      expect([ra.status, rb.status]).toEqual([200, 200])

      const open = await openRows(who.id)
      expect(open).toHaveLength(1)
      // And the loser's room was left by a switch, not abandoned open.
      const loser = open[0].event_id === a.id ? b.id : a.id
      const closed = await db.event_check_ins.findFirstOrThrow({ where: { event_id: loser, user_id: who.id }, select: { status: true } })
      expect(closed.status).toBe("checked_out")
    }
  })

  it("the losing door switches out of a room opened after its own clock, never before the arrival", async () => {
    // The race, held still: the winner's row arrived a moment after the loser's `now`.
    const who = await person()
    const a = await event("Winner")
    const b = await event("Loser")
    const winnerAt = new Date()
    await putInRoom({ eventId: a.id, occurrenceId: a.occurrences[0], userId: who.id, at: winnerAt })
    const loserNow = new Date(winnerAt.getTime() - 5)

    const [switched] = await checkOutOfOtherEvents(who.id, { eventId: b.id, occurrenceId: b.occurrences[0] }, loserNow)

    expect(switched).toMatchObject({ changed: true, reason: "switched_event", left: { eventId: a.id, name: "Winner" } })
    const session = await db.presence_sessions.findFirstOrThrow({ where: { event_id: a.id, user_id: who.id } })
    expect(session.departed_at!.getTime()).toBeGreaterThanOrEqual(session.arrived_at.getTime())
  })

  it("a session the winning door writes after the loser switched it out is closed, never left counting them inside", async () => {
    const who = await person()
    const a = await event("Winner's room")
    const b = await event("Loser's room")
    const at = new Date()
    // The winner's row is written; its session (not awaited at the door) has not landed yet.
    await db.event_check_ins.create({ data: { event_id: a.id, occurrence_id: a.occurrences[0], user_id: who.id, status: "checked_in", check_in_time: at } })
    // The loser's switch closes the row and finds no session to close.
    await checkOutOfOtherEvents(who.id, { eventId: b.id, occurrenceId: b.occurrences[0] }, at)
    // Then the winner's session lands.
    await openSeatSession({ eventId: a.id, occurrenceId: a.occurrences[0], userId: who.id, at })

    expect(await db.presence_sessions.count({ where: { user_id: who.id, departed_at: null } })).toBe(0)
    const s = await db.presence_sessions.findFirstOrThrow({ where: { event_id: a.id, user_id: who.id } })
    expect(s).toMatchObject({ departed_source: "switch" })
    expect(s.departed_at!.getTime()).toBeGreaterThanOrEqual(s.arrived_at.getTime())
  })

  it("a session beside a row still open stays open", async () => {
    const who = await person()
    const a = await event("Still here")
    await db.event_check_ins.create({ data: { event_id: a.id, occurrence_id: a.occurrences[0], user_id: who.id, status: "checked_in", check_in_time: new Date() } })
    await openSeatSession({ eventId: a.id, occurrenceId: a.occurrences[0], userId: who.id, at: new Date() })
    expect(await db.presence_sessions.count({ where: { user_id: who.id, departed_at: null } })).toBe(1)
  })

  it("an earlier day of the same event closes when today's opens, as that day's end", async () => {
    const who = await person()
    // Day 1 ended an hour ago (still open: the sweeper has not come); day 2 is on now.
    const run = await event("Two-day run", [
      { startMin: -26 * 60, endMin: -60 },
      { startMin: -30, endMin: 120 },
    ])
    await putInRoom({ eventId: run.id, occurrenceId: run.occurrences[0], userId: who.id, at: new Date(Date.now() - 25 * 3_600_000) })

    const res = await checkIn(run.id, who.token)
    expect(res.status).toBe(200)
    // The same room: nothing was left, so nothing to tell them.
    expect(res.json.data.left).toEqual([])

    expect(await openRows(who.id)).toEqual([{ event_id: run.id, occurrence_id: run.occurrences[1] }])
    const day1 = await db.presence_sessions.findFirstOrThrow({ where: { occurrence_id: run.occurrences[0], user_id: who.id } })
    // `occurrence_ended` is inferred (`sweeper`), never a switch.
    expect(day1.departed_source).toBe("sweeper")
    // Closed when that day ended, not at today's door (L5).
    const end = (await db.event_occurrences.findUniqueOrThrow({ where: { id: run.occurrences[0] } })).end_time
    expect(day1.departed_at).toEqual(end)
    const row = await db.event_check_ins.findFirstOrThrow({ where: { occurrence_id: run.occurrences[0], user_id: who.id } })
    expect(row.check_out_time).toEqual(end)
  })
})

describe("the switch is never silent", () => {
  it("names the room a check-in took you out of", async () => {
    const who = await person()
    const a = await event("Fandom")
    const b = await event("Neon Nights")

    expect((await checkIn(a.id, who.token)).json.data.left).toEqual([])
    const res = await checkIn(b.id, who.token)

    expect(res.status).toBe(200)
    expect(res.json.data.left).toEqual([{ eventId: a.id, kind: "event", name: "Fandom" }])
    expect(await openRows(who.id)).toEqual([{ event_id: b.id, occurrence_id: b.occurrences[0] }])
  })

  it("checking in again where you already are leaves nothing", async () => {
    const who = await person()
    const a = await event("Same place")
    await checkIn(a.id, who.token)
    const again = await checkIn(a.id, who.token)
    expect(again.status).toBe(200)
    expect(again.json.data.left).toEqual([])
    expect(await openRows(who.id)).toHaveLength(1)
  })
})
