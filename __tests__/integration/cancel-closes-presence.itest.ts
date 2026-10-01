/*
 * Cancelling an event closes the presence sessions inside it (SCRUM-490).
 *
 * Found on staging: `cancelEventCheckIns` cancelled the check-ins and left the
 * sessions open, and nothing else closes a session whose check-in is no longer
 * `checked_in`. "Inside" is `departed_at IS NULL`, so a cancelled room reported
 * its last headcount for good: 7 open sessions on 3 cancelled events.
 */
import { cancelEventCheckIns } from "@/lib/event-cancellation"
import { headcount } from "@/lib/presence-sessions"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function room(host: string) {
  const eventId = await makeEvent(host)
  events.push(eventId)
  return { eventId, occurrenceId: await occurrenceOf(eventId) }
}

async function host() {
  const id = await makeUser(testId("cp-host"), "organizer")
  users.push(id)
  return id
}

async function guest() {
  const id = await makeUser(testId("cp-guest"))
  users.push(id)
  return id
}

const sessionOf = (eventId: string, userId: string) =>
  db.presence_sessions.findFirstOrThrow({
    where: { event_id: eventId, user_id: userId },
    select: { departed_at: true, departed_source: true },
  })

it("closes the sessions of everyone inside, as ended, and the room is empty", async () => {
  const r = await room(await host())
  const who = await guest()
  await putInRoom({ ...r, userId: who })
  expect((await headcount({ occurrenceId: r.occurrenceId })).insideGuests).toBe(1)
  const before = Date.now()

  expect(await cancelEventCheckIns(r.eventId)).toBe(1)

  const s = await sessionOf(r.eventId, who)
  expect(s.departed_source).toBe("ended")
  expect(s.departed_at!.getTime()).toBeGreaterThanOrEqual(before)
  expect((await headcount({ occurrenceId: r.occurrenceId })).insideGuests).toBe(0)
})

it("closes a session whose arrival is later than the cancel, at its arrival", async () => {
  // A seeded world's sessions start in the future, and so can a check-in racing
  // the cancel. `departed_at >= arrived_at` is a CHECK: one such row must not
  // fail the cascade for everyone.
  const r = await room(await host())
  const who = await guest()
  const arrives = new Date(Date.now() + 60 * 60_000)
  await putInRoom({ ...r, userId: who, at: arrives })

  await cancelEventCheckIns(r.eventId)

  expect(await sessionOf(r.eventId, who)).toEqual({ departed_at: arrives, departed_source: "ended" })
})

it("leaves a departure that already happened as it was", async () => {
  const r = await room(await host())
  const who = await guest()
  const left = new Date(Date.now() - 30 * 60_000)
  await putInRoom({ ...r, userId: who, at: new Date(Date.now() - 60 * 60_000) })
  await db.presence_sessions.updateMany({
    where: { event_id: r.eventId, user_id: who },
    data: { departed_at: left, departed_source: "user" },
  })

  await cancelEventCheckIns(r.eventId)

  expect(await sessionOf(r.eventId, who)).toEqual({ departed_at: left, departed_source: "user" })
})

it("closes nothing in another event", async () => {
  const organiser = await host()
  const cancelled = await room(organiser)
  const elsewhere = await room(organiser)
  const who = await guest()
  await putInRoom({ ...elsewhere, userId: who })

  await cancelEventCheckIns(cancelled.eventId)

  expect((await sessionOf(elsewhere.eventId, who)).departed_at).toBeNull()
})
