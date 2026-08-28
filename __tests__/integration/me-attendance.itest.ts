import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { distinctEventsAttended } from "@/lib/attendee-counts"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * The events behind the number, and the number behind the events.
 *
 * The profile has always said "N events attended" with no way to see which N.
 * The interesting property is not that a list comes back — it is that the list
 * and the count are the **same answer**, because they are the two halves a user
 * compares. "7 events attended" above a list of 9 is worse than either alone.
 *
 * A multi-day event is where they come apart: `event_check_ins` holds a row per
 * person per occurrence, so counting rows told a three-day-conference attendee
 * they had been to three events (I1). Every test here uses a multi-day fixture
 * for that reason — on single-day events the correct and incorrect
 * implementations agree, and the suite would pass either way.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const meAttendance = require("@/app/api/mobile/me/attendance/route") as
  typeof import("@/app/api/mobile/me/attendance/route")

const users: string[] = []
const events: string[] = []
const DAY = 24 * 60 * 60 * 1000

afterAll(async () => {
  if (events.length) {
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function pastEvent(label: string, days: number, daysAgo: number) {
  const owner = users[0]
  const start = new Date(Date.now() - daysAgo * DAY)
  const event = await db.events.create({
    data: {
      slug: testId(label),
      title: `${label} ${testId("t")}`,
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + days * DAY),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)

  const occurrences = []
  for (let d = 0; d < days; d++) {
    const on = new Date(start.getTime() + d * DAY)
    occurrences.push(
      await db.event_occurrences.create({
        data: {
          event_id: event.id,
          occurs_on: new Date(on.toISOString().slice(0, 10)),
          start_time: on,
          end_time: new Date(on.getTime() + 4 * 60 * 60 * 1000),
        },
      })
    )
  }
  return { id: event.id, occurrences, start }
}

/** Check somebody in on every day of an event — the multi-day row explosion. */
async function attendEveryDay(
  userId: string,
  event: { id: string; occurrences: Array<{ id: string; start_time: Date }> }
) {
  for (const o of event.occurrences) {
    await db.event_check_ins.create({
      data: {
        event_id: event.id,
        occurrence_id: o.id,
        user_id: userId,
        kind: "attendee",
        status: "checked_out",
        check_in_time: o.start_time,
      },
    })
  }
}

const fetchMine = (token: string, qs = "") =>
  meAttendance.GET(
    new NextRequest(`http://localhost/api/mobile/me/attendance${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  )

describe("GET /me/attendance", () => {
  let me: string
  let token: string

  beforeAll(async () => {
    const owner = await makeUser(testId("att_own"), "organizer")
    users.push(owner)
    me = await makeUser(testId("att_me"))
    users.push(me)
    const u = await db.user.findUniqueOrThrow({ where: { id: me }, select: { email: true } })
    token = signAccessToken(me, u.email)
  })

  it("returns one row per event, not one per day attended", async () => {
    const conference = await pastEvent("conf", 3, 30)
    const night = await pastEvent("night", 1, 10)
    await attendEveryDay(me, conference)
    await attendEveryDay(me, night)

    const res = await fetchMine(token)
    expect(res.status).toBe(200)
    const body = await res.json()

    // The control: four check-in rows exist across the two events, so a
    // row-counting implementation would return four.
    const rowCount = await db.event_check_ins.count({
      where: { user_id: me, event_id: { in: [conference.id, night.id] } },
    })
    expect(rowCount).toBe(4)

    expect(body.data.events).toHaveLength(2)
    expect(body.data.events.map((e: { id: string }) => e.id).sort()).toEqual(
      [conference.id, night.id].sort()
    )
  })

  it("agrees with the count the profile shows", async () => {
    /*
     * The property that matters. These are the two halves a user compares, and
     * they are computed by two different queries — so they can drift, and the
     * only thing stopping them is that they share a predicate.
     *
     * The staff shift below is what makes that checkable. A recorded control
     * removed `kind = 'attendee'` from the list query and this test stayed
     * green, because every fixture row was an attendee and the two predicates
     * could not disagree about anything. Working an event is not attending it —
     * `distinctEventsAttended` excludes it, so the list must too, and now there
     * is a row that tells them apart.
     */
    const staffed = await pastEvent("staffed", 1, 5)
    await db.event_check_ins.create({
      data: {
        event_id: staffed.id,
        occurrence_id: staffed.occurrences[0].id,
        user_id: me,
        kind: "staff",
        status: "checked_out",
        check_in_time: staffed.occurrences[0].start_time,
      },
    })

    const res = await fetchMine(token, "?limit=50")
    const body = await res.json()
    const count = await distinctEventsAttended(me)

    expect({
      listed: body.data.events.length,
      counted: count,
      total: body.data.pagination.totalCount,
    }).toEqual({ listed: count, counted: count, total: count })

    // And specifically: the shift is not in the list.
    expect(body.data.events.map((e: { id: string }) => e.id)).not.toContain(staffed.id)
  })

  it("puts the most recently attended event first", async () => {
    const res = await fetchMine(token, "?limit=50")
    const body = await res.json()
    const times = body.data.events.map((e: { attendedAt: string }) => new Date(e.attendedAt).getTime())

    expect(times.length).toBeGreaterThan(1)
    expect([...times]).toEqual([...times].sort((a: number, b: number) => b - a))
  })

  it("reports the first day of a multi-day event, not the last", async () => {
    /*
     * "When did you go to this" is the day they arrived. `DISTINCT ON` with an
     * ascending inner order is what picks that row; flip it and a conference
     * reads as having been attended on its final day.
     */
    const res = await fetchMine(token, "?limit=50")
    const body = await res.json()
    const conference = body.data.events.find((e: { title: string }) => e.title.startsWith("conf"))

    expect(conference).toBeTruthy()
    const firstCheckIn = await db.event_check_ins.findFirstOrThrow({
      where: { user_id: me, event_id: conference.id },
      orderBy: { check_in_time: "asc" },
      select: { check_in_time: true },
    })
    expect(new Date(conference.attendedAt).getTime()).toBe(firstCheckIn.check_in_time!.getTime())
  })

  it("refuses an unauthenticated caller", async () => {
    const res = await meAttendance.GET(
      new NextRequest("http://localhost/api/mobile/me/attendance")
    )
    expect(res.status).toBe(401)
  })

  it("shows one person nothing of another's", async () => {
    /*
     * Scoped by construction — there is no id in the path — so this asserts the
     * shape of the endpoint rather than a check inside it. It is the reason the
     * route is `/me`: attendance history is where somebody was on which nights,
     * and TR4 rejected putting it on a chain for exactly that reason.
     */
    const stranger = await makeUser(testId("att_other"))
    users.push(stranger)
    const su = await db.user.findUniqueOrThrow({
      where: { id: stranger },
      select: { email: true },
    })

    const res = await fetchMine(signAccessToken(stranger, su.email))
    const body = await res.json()
    expect(body.data.events).toEqual([])
    expect(body.data.pagination.totalCount).toBe(0)
  })
})
