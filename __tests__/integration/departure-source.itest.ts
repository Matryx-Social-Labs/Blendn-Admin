/*
 * How a presence session ended, as `performCheckout` records it (SCRUM-484).
 *
 * Found on staging: every checkout that was not the person's own was stored as
 * `departed_source = 'sweeper'`, "closed on silence". A switch, which is the
 * person checking in somewhere else at a known instant, read as the soft case,
 * and `switch` was never written at all.
 *
 * The event ending stays `sweeper` on purpose: the sweeper closes someone who
 * never checked out, an hour after the end, and when they actually left is a
 * guess. `departureQuality` must go on counting that as inference.
 */
import { checkOutOfOtherEvents, performCheckout, type CheckoutReason } from "@/lib/checkout"
import { departureQuality } from "@/lib/presence-sessions"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function inRoom() {
  const host = await makeUser(testId("ds-host"), "organizer")
  const who = await makeUser(testId("ds-who"))
  users.push(host, who)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const occurrenceId = await occurrenceOf(eventId)
  await putInRoom({ eventId, occurrenceId, userId: who })
  const { id } = await db.event_check_ins.findFirstOrThrow({ where: { event_id: eventId, user_id: who }, select: { id: true } })
  return { host, who, eventId, checkInId: id }
}

const sourceOf = async (eventId: string, userId: string) =>
  (await db.presence_sessions.findFirstOrThrow({ where: { event_id: eventId, user_id: userId }, select: { departed_source: true } }))
    .departed_source

it("records checking in somewhere else as a switch", async () => {
  const a = await inRoom()
  const elsewhere = await makeEvent(a.host)
  events.push(elsewhere)

  const [result] = await checkOutOfOtherEvents(a.who, elsewhere)
  expect(result).toMatchObject({ changed: true, eventId: a.eventId })
  expect(await sourceOf(a.eventId, a.who)).toBe("switch")
})

it.each<[CheckoutReason, "user" | "sweeper"]>([
  ["manual", "user"],
  ["left_area", "sweeper"],
  // Inferred, not observed: see the header.
  ["occurrence_ended", "sweeper"],
])("records a %s checkout as %s", async (reason, source) => {
  const a = await inRoom()
  await performCheckout(a.checkInId, reason)
  expect(await sourceOf(a.eventId, a.who)).toBe(source)
})

it("counts the event's end as inference when judging the headcount", async () => {
  const a = await inRoom()
  await performCheckout(a.checkInId, "occurrence_ended")
  expect(await departureQuality(await occurrenceOf(a.eventId))).toEqual({ closed: 1, bySweeper: 1, degraded: true })
})
