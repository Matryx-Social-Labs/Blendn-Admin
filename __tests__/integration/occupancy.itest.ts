import { getOccupancy, getOccupancies } from "@/lib/occupancy"
import { buildLiveSnapshot } from "@/lib/live-snapshot"

import { db, closeDb, makeUser, makeEvent, occurrenceOf, testId } from "./helpers"

/**
 * Occupancy is counted, never stored.
 *
 * `events.current_capacity` was a stored counter doing three jobs at once —
 * what the room holds, who is in it, and who came. Every write path had to
 * maintain it, and two bugs shipped from that in a single day.
 *
 * Worse, it had already been abandoned in one place: `lib/live-snapshot.ts`
 * counts check-in rows directly and says why. So the live event screen and the
 * chatrooms screen answered the same question with different numbers. The last
 * test here is the one that stops them drifting apart again.
 */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function eventWithCapacity(capacity: number | null) {
  const owner = await makeUser(testId("occ_own"), "organizer")
  users.push(owner)
  const eventId = await makeEvent(owner)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { max_capacity: capacity } })
  return { eventId, occurrenceId: await occurrenceOf(eventId) }
}

async function checkIn(
  eventId: string,
  occurrenceId: string,
  label: string,
  kind: "attendee" | "staff" = "attendee"
) {
  const userId = await makeUser(testId(label))
  users.push(userId)
  await db.event_check_ins.create({
    data: {
      event_id: eventId,
      occurrence_id: occurrenceId,
      user_id: userId,
      kind,
      status: "checked_in",
      check_in_time: new Date(),
    },
  })
  return userId
}

describe("occupancy is derived", () => {
  it("counts who is in the room right now", async () => {
    const { eventId, occurrenceId } = await eventWithCapacity(100)
    await checkIn(eventId, occurrenceId, "a")
    await checkIn(eventId, occurrenceId, "b")

    const occ = await getOccupancy(eventId)
    expect(occ.inside).toBe(2)
    expect(occ.uniqueAttendance).toBe(2)
  })

  it("drops when someone checks out, and rises again when they return", async () => {
    // The v0.40.1 regression. With a stored counter, re-entry stopped
    // incrementing while checkout kept decrementing, so every smoke break
    // permanently undercounted the room by one.
    const { eventId, occurrenceId } = await eventWithCapacity(100)
    const userId = await checkIn(eventId, occurrenceId, "smoker")

    expect((await getOccupancy(eventId)).inside).toBe(1)

    await db.event_check_ins.updateMany({
      where: { event_id: eventId, user_id: userId },
      data: { status: "checked_out", check_out_time: new Date() },
    })
    expect((await getOccupancy(eventId)).inside).toBe(0)

    await db.event_check_ins.updateMany({
      where: { event_id: eventId, user_id: userId },
      data: { status: "checked_in", check_out_time: null },
    })
    expect((await getOccupancy(eventId)).inside).toBe(1)

    // And they are one person, however many times they went in and out.
    expect((await getOccupancy(eventId)).uniqueAttendance).toBe(1)
  })

  it("goes over a stated capacity rather than refusing — the queue case", async () => {
    // The geofence covers the pavement, so a 2-capacity venue can genuinely
    // have 3 people inside the boundary. Refusing the third denied them the
    // chatroom and erased them from attendance.
    const { eventId, occurrenceId } = await eventWithCapacity(2)
    await checkIn(eventId, occurrenceId, "q1")
    await checkIn(eventId, occurrenceId, "q2")
    await checkIn(eventId, occurrenceId, "q3")

    const occ = await getOccupancy(eventId)
    expect(occ.inside).toBe(3)
    expect(occ.overCapacity).toBe(true)
    expect(occ.fillPct).toBe(150)
  })

  it("reports no fill for an event with no stated capacity", async () => {
    // Null, not zero: an event without a capacity has no fill to report, which
    // is different from being empty.
    const { eventId, occurrenceId } = await eventWithCapacity(null)
    await checkIn(eventId, occurrenceId, "nc")
    const occ = await getOccupancy(eventId)
    expect(occ.fillPct).toBeNull()
    expect(occ.overCapacity).toBe(false)
  })
})

describe("staff count towards the room, not towards attendance", () => {
  it("splits the live number and keeps attendance to guests", async () => {
    const { eventId, occurrenceId } = await eventWithCapacity(100)
    await checkIn(eventId, occurrenceId, "guest1")
    await checkIn(eventId, occurrenceId, "guest2")
    await checkIn(eventId, occurrenceId, "crew", "staff")

    const occ = await getOccupancy(eventId)
    // Fire safety counts bodies.
    expect(occ.inside).toBe(3)
    expect(occ.staffInside).toBe(1)
    expect(occ.guestsInside).toBe(2)
    // The business number does not.
    expect(occ.uniqueAttendance).toBe(2)
  })

  it("measures fill against guests, so crew do not fill the room", async () => {
    const { eventId, occurrenceId } = await eventWithCapacity(2)
    await checkIn(eventId, occurrenceId, "g1")
    await checkIn(eventId, occurrenceId, "crew1", "staff")
    await checkIn(eventId, occurrenceId, "crew2", "staff")

    const occ = await getOccupancy(eventId)
    expect(occ.inside).toBe(3)
    // Two of the three are working. The room is half full, not over.
    expect(occ.fillPct).toBe(50)
    expect(occ.overCapacity).toBe(false)
  })
})

describe("getOccupancies (the batched form)", () => {
  it("returns a zero entry for an event with nobody in it", async () => {
    // The chatrooms page sums across every live event; a missing key would
    // read as undefined and render "NaN on site".
    const { eventId } = await eventWithCapacity(50)
    const map = await getOccupancies([eventId])
    expect(map.get(eventId)).toEqual({ inside: 0, guestsInside: 0 })
  })

  it("agrees with the single-event form", async () => {
    const { eventId, occurrenceId } = await eventWithCapacity(50)
    await checkIn(eventId, occurrenceId, "batch1")
    await checkIn(eventId, occurrenceId, "batchcrew", "staff")

    const one = await getOccupancy(eventId)
    const many = await getOccupancies([eventId])
    expect(many.get(eventId)!.inside).toBe(one.inside)
    expect(many.get(eventId)!.guestsInside).toBe(one.guestsInside)
  })

  it("handles an empty list without querying", async () => {
    expect((await getOccupancies([])).size).toBe(0)
  })
})

describe("the two screens must agree", () => {
  it("live snapshot and occupancy report the same number", async () => {
    // This is the bug that existed before any of this work: the live event
    // screen counted rows while the chatrooms screen summed a stored column.
    // One of them was always stale, and nothing caught it.
    const { eventId, occurrenceId } = await eventWithCapacity(100)
    await checkIn(eventId, occurrenceId, "agree1")
    await checkIn(eventId, occurrenceId, "agree2")
    const left = await checkIn(eventId, occurrenceId, "agree3")
    await db.event_check_ins.updateMany({
      where: { event_id: eventId, user_id: left },
      data: { status: "checked_out", check_out_time: new Date() },
    })

    const snapshot = await buildLiveSnapshot(eventId)
    const occ = await getOccupancy(eventId)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.inside).toBe(occ.inside)
  })
})

describe("per-occurrence capacity", () => {
  /**
   * `event_occurrences.capacity` existed from the multi-day work and was read by
   * nothing, so a conference whose last day moves to a smaller room had its fill
   * measured against the whole run's number — and over-capacity on the day it
   * mattered was invisible, which is the one thing this module exists to show.
   */
  it("measures against today's capacity when the day states one", async () => {
    const host = await makeUser("poc-host", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { max_capacity: 500 } })

    // The room today holds 10, not the 500 the run is sized for.
    const occurrenceId = await occurrenceOf(eventId)
    await db.event_occurrences.update({ where: { id: occurrenceId }, data: { capacity: 10 } })

    for (let i = 0; i < 12; i++) {
      const u = await makeUser(`poc-g${i}`)
      users.push(u)
      await db.event_check_ins.create({
        data: {
          user_id: u,
          event_id: eventId,
          occurrence_id: occurrenceId,
          check_in_time: new Date(),
          status: "checked_in",
        },
      })
    }

    const o = await getOccupancy(eventId)
    expect(o.capacity).toBe(10)
    expect(o.overCapacity).toBe(true)
    expect(o.fillPct).toBe(120)
  })

  it("falls back to the event's when the day states none", async () => {
    // The common case: one capacity, and every day of the run holds it.
    const host = await makeUser("poc-host2", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { max_capacity: 80 } })

    const o = await getOccupancy(eventId)
    expect(o.capacity).toBe(80)
  })
})
