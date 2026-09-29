import { syncOccurrences } from "@/lib/occurrences"

import { holdSeedOccurrences } from "../../scripts/seed-occurrences"

import { db, closeDb, makeUser, makeEvent, testId } from "./helpers"

/**
 * The scenario seed re-times its events on every run (SCRUM-471).
 *
 * It synced the occurrences and then cleared `cancelled_at` on all of them, so
 * a day the event had moved off — cancelled by the sync because people had
 * checked in to it — came back as a live session. On staging that left three
 * events with a held day they no longer run, one of them carrying 29
 * check-ins.
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

const SAT = { start: new Date("2026-10-03T15:00:00Z"), end: new Date("2026-10-03T18:00:00Z") }
const SUN = { start: new Date("2026-10-04T15:00:00Z"), end: new Date("2026-10-04T18:00:00Z") }

const place = (eventId: string, day: { start: Date; end: Date }) =>
  holdSeedOccurrences(db, eventId, 40, () => syncOccurrences(eventId, day.start, day.end, "UTC"))

async function seededOn(day: { start: Date; end: Date }) {
  const owner = await makeUser(testId("seedocc_owner"), "organizer")
  users.push(owner)
  const eventId = await makeEvent(owner)
  events.push(eventId)
  await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
  await place(eventId, day)
  return eventId
}

const days = (eventId: string) =>
  db.event_occurrences.findMany({
    where: { event_id: eventId },
    orderBy: { occurs_on: "asc" },
    select: { occurs_on: true, cancelled_at: true, capacity: true },
  })

const iso = (d: Date) => d.toISOString().slice(0, 10)

describe("holdSeedOccurrences", () => {
  it("leaves a dropped day that people attended cancelled, not live", async () => {
    const eventId = await seededOn(SAT)
    const attendee = await makeUser(testId("seedocc_guest"))
    users.push(attendee)
    const saturday = await db.event_occurrences.findFirstOrThrow({ where: { event_id: eventId } })
    await db.event_check_ins.create({
      data: { event_id: eventId, occurrence_id: saturday.id, user_id: attendee, status: "checked_out", check_in_time: SAT.start },
    })

    await place(eventId, SUN)

    const after = await days(eventId)
    expect(after.map((d) => [iso(d.occurs_on), d.cancelled_at !== null])).toEqual([
      ["2026-10-03", true],
      ["2026-10-04", false],
    ])
    // The attendance is still there; only the day stopped being held.
    expect(await db.event_check_ins.count({ where: { occurrence_id: saturday.id } })).toBe(1)
  })

  it("deletes a dropped day nobody attended", async () => {
    const eventId = await seededOn(SAT)

    await place(eventId, SUN)

    expect((await days(eventId)).map((d) => iso(d.occurs_on))).toEqual(["2026-10-04"])
  })

  it("holds every day in the span again and sets its capacity", async () => {
    const eventId = await seededOn(SAT)
    await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: { cancelled_at: new Date(), capacity: 5 } })

    await place(eventId, SAT)

    expect(await days(eventId)).toEqual([{ occurs_on: new Date("2026-10-03T00:00:00Z"), cancelled_at: null, capacity: 40 }])
  })
})
