import { syncOccurrences } from "@/lib/occurrences"

import { db, closeDb, makeUser, makeEvent, testId } from "./helpers"

/**
 * Shrinking an event must not erase who came.
 *
 * `event_check_ins.occurrence_id` cascades on delete, so removing an occurrence
 * destroys its attendance. An organiser correcting an end date by a day would
 * silently erase the last day's check-ins, with no warning and no undo.
 *
 * Attendance is a record of something that actually happened. The schedule
 * changing does not unhappen it.
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

async function threeDayEvent() {
  const owner = await makeUser(testId("occ_owner"), "organizer")
  users.push(owner)
  const eventId = await makeEvent(owner)
  events.push(eventId)

  const start = new Date("2026-10-01T09:00:00Z")
  const end = new Date("2026-10-03T18:00:00Z")
  await db.events.update({
    where: { id: eventId },
    data: { start_time: start, end_time: end, timezone: "UTC" },
  })
  await syncOccurrences(eventId, start, end, "UTC")
  return { eventId, owner }
}

describe("syncOccurrences", () => {
  it("creates one occurrence per day", async () => {
    const { eventId } = await threeDayEvent()
    expect(await db.event_occurrences.count({ where: { event_id: eventId } })).toBe(3)
  })

  it("keeps a day's id across a time-only change, so its check-ins survive", async () => {
    const { eventId } = await threeDayEvent()
    const before = await db.event_occurrences.findMany({
      where: { event_id: eventId },
      orderBy: { occurs_on: "asc" },
      select: { id: true },
    })

    // Programme now starts an hour earlier. Same days.
    await syncOccurrences(
      eventId,
      new Date("2026-10-01T08:00:00Z"),
      new Date("2026-10-03T18:00:00Z"),
      "UTC"
    )

    const after = await db.event_occurrences.findMany({
      where: { event_id: eventId },
      orderBy: { occurs_on: "asc" },
      select: { id: true },
    })
    expect(after.map((o) => o.id)).toEqual(before.map((o) => o.id))
  })

  it("CANCELS a dropped day that has attendance, rather than deleting it", async () => {
    const { eventId } = await threeDayEvent()
    const attendee = await makeUser(testId("occ_att"))
    users.push(attendee)

    const lastDay = await db.event_occurrences.findFirst({
      where: { event_id: eventId },
      orderBy: { occurs_on: "desc" },
      select: { id: true },
    })
    await db.event_check_ins.create({
      data: {
        event_id: eventId,
        occurrence_id: lastDay!.id,
        user_id: attendee,
        status: "checked_in",
        check_in_time: new Date(),
      },
    })

    // The organiser shortens the run to two days.
    await syncOccurrences(
      eventId,
      new Date("2026-10-01T09:00:00Z"),
      new Date("2026-10-02T18:00:00Z"),
      "UTC"
    )

    const survivor = await db.event_occurrences.findUnique({ where: { id: lastDay!.id } })
    expect(survivor).not.toBeNull()
    expect(survivor!.cancelled_at).not.toBeNull()

    // The whole point: the check-in is still there.
    expect(
      await db.event_check_ins.count({ where: { occurrence_id: lastDay!.id } })
    ).toBe(1)
  })

  it("DELETES a dropped day nobody attended", async () => {
    // An empty row for a day that never ran is just noise.
    const { eventId } = await threeDayEvent()
    await syncOccurrences(
      eventId,
      new Date("2026-10-01T09:00:00Z"),
      new Date("2026-10-02T18:00:00Z"),
      "UTC"
    )
    expect(await db.event_occurrences.count({ where: { event_id: eventId } })).toBe(2)
  })

  it("re-adding a day that was cancelled brings it back", async () => {
    const { eventId } = await threeDayEvent()
    const attendee = await makeUser(testId("occ_att2"))
    users.push(attendee)
    const lastDay = await db.event_occurrences.findFirst({
      where: { event_id: eventId },
      orderBy: { occurs_on: "desc" },
      select: { id: true },
    })
    await db.event_check_ins.create({
      data: {
        event_id: eventId,
        occurrence_id: lastDay!.id,
        user_id: attendee,
        status: "checked_in",
        check_in_time: new Date(),
      },
    })

    await syncOccurrences(eventId, new Date("2026-10-01T09:00:00Z"), new Date("2026-10-02T18:00:00Z"), "UTC")
    await syncOccurrences(eventId, new Date("2026-10-01T09:00:00Z"), new Date("2026-10-03T18:00:00Z"), "UTC")

    // Same row, same check-in — not a fresh day that lost its history.
    const back = await db.event_occurrences.findUnique({ where: { id: lastDay!.id } })
    expect(back).not.toBeNull()
    expect(await db.event_check_ins.count({ where: { occurrence_id: lastDay!.id } })).toBe(1)
  })
})
