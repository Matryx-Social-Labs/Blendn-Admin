/*
 * A session nothing could close (0g).
 *
 * "Inside" is `departed_at IS NULL`, and the sweeper found people through
 * `event_check_ins.status = 'checked_in'`. A session whose check-in row was no
 * longer `checked_in` — cancelled before SCRUM-490 cascaded to sessions, or
 * never written at all — was reachable by nothing, so it counted as present
 * for ever. Found on staging: 8 open sessions on 4 events that ended 12 to 20
 * days earlier, 7 behind `cancelled` rows and 1 behind no row.
 */
import { OCCURRENCE_GRACE_MINUTES } from "@/lib/presence"
import { closeStrandedSessions } from "@/lib/presence-sessions"
import { sweepPresence } from "@/lib/presence-sweeper"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

// performCheckout reaches socket-server -> mobile-auth -> jose, which jest cannot load.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const MIN = 60_000
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

/** An event whose one occurrence ran from `startedAgo` to `endedAgo` minutes ago. */
async function occurrence(startedAgo: number, endedAgo: number) {
  const host = await makeUser(testId("st-host"), "organizer")
  users.push(host)
  const start = new Date(Date.now() - startedAgo * MIN)
  const end = new Date(Date.now() - endedAgo * MIN)
  const event = await db.events.create({
    data: {
      slug: testId("st"),
      title: "Stranded fixture",
      description: "integration fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "published",
      organizer_id: host,
    },
  })
  events.push(event.id)
  const occ = await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  return { eventId: event.id, occurrenceId: occ.id, start, end }
}

type Room = Awaited<ReturnType<typeof occurrence>>

/** A guest with an open session, and a check-in row in the given state (or none). */
async function guest(room: Room, checkIn: "cancelled" | "checked_in" | "checked_out" | null, arrivedAfter = 10) {
  const userId = await makeUser(testId("st-guest"))
  users.push(userId)
  const arrived = new Date(room.start.getTime() + arrivedAfter * MIN)
  if (checkIn) {
    await db.event_check_ins.create({
      data: {
        event_id: room.eventId,
        occurrence_id: room.occurrenceId,
        user_id: userId,
        status: checkIn,
        check_in_time: arrived,
        last_seen_at: arrived,
      },
    })
  }
  await db.presence_sessions.create({
    data: { event_id: room.eventId, occurrence_id: room.occurrenceId, user_id: userId, arrived_at: arrived, last_seen_at: arrived },
  })
  return { userId, arrived }
}

const sessionOf = (room: Room, userId: string) =>
  db.presence_sessions.findFirstOrThrow({
    where: { occurrence_id: room.occurrenceId, user_id: userId },
    select: { departed_at: true, departed_source: true },
  })

describe("closeStrandedSessions", () => {
  it("closes a session behind a cancelled check-in at the occurrence's end, as inferred", async () => {
    const room = await occurrence(24 * 60 + 180, 24 * 60)
    const { userId } = await guest(room, "cancelled")

    const closed = await closeStrandedSessions()

    expect(closed).toBeGreaterThanOrEqual(1)
    expect(await sessionOf(room, userId)).toEqual({ departed_at: room.end, departed_source: "sweeper" })
  })

  it("closes a session that has no check-in row at all", async () => {
    const room = await occurrence(24 * 60 + 180, 24 * 60)
    const { userId } = await guest(room, null)

    await closeStrandedSessions()

    expect((await sessionOf(room, userId)).departed_at).toEqual(room.end)
  })

  it("closes one behind a checked-out row, which a checkout that lost a race leaves", async () => {
    const room = await occurrence(24 * 60 + 180, 24 * 60)
    const { userId } = await guest(room, "checked_out")

    await closeStrandedSessions()

    expect((await sessionOf(room, userId)).departed_source).toBe("sweeper")
  })

  it("never records a departure before the arrival", async () => {
    // Arrived after the occurrence ended: `departed_at >= arrived_at` is a CHECK,
    // and one such row must not fail the statement for everyone else.
    const room = await occurrence(24 * 60 + 180, 24 * 60)
    const { userId, arrived } = await guest(room, null, 180 + 30)
    const ok = await guest(room, null)

    await closeStrandedSessions()

    expect((await sessionOf(room, userId)).departed_at).toEqual(arrived)
    expect((await sessionOf(room, ok.userId)).departed_at).toEqual(room.end)
  })

  it("leaves a room still inside its grace alone", async () => {
    const room = await occurrence(180 + OCCURRENCE_GRACE_MINUTES, OCCURRENCE_GRACE_MINUTES - 5)
    const { userId } = await guest(room, "cancelled")

    await closeStrandedSessions()

    expect((await sessionOf(room, userId)).departed_at).toBeNull()
  })

  it("leaves a room that is still running alone", async () => {
    const room = await occurrence(60, -60)
    const { userId } = await guest(room, null)

    await closeStrandedSessions()

    expect((await sessionOf(room, userId)).departed_at).toBeNull()
  })

  it("leaves a session whose check-in is still open to the checkout path, which has more to do", async () => {
    // The checkout path also cuts chat access, emits the socket event and
    // stamps the check-in. Closing only the session would strand the rest.
    const room = await occurrence(24 * 60 + 180, 24 * 60)
    const { userId } = await guest(room, "checked_in")

    await closeStrandedSessions()

    expect((await sessionOf(room, userId)).departed_at).toBeNull()
  })

  it("keeps a departure that already happened, and is idempotent", async () => {
    const room = await occurrence(24 * 60 + 180, 24 * 60)
    const { userId } = await guest(room, null)
    const left = new Date(room.start.getTime() + 40 * MIN)
    await db.presence_sessions.updateMany({
      where: { occurrence_id: room.occurrenceId, user_id: userId },
      data: { departed_at: left, departed_source: "user" },
    })
    const open = await guest(room, null)

    await closeStrandedSessions()
    const again = await closeStrandedSessions()

    expect(await sessionOf(room, userId)).toEqual({ departed_at: left, departed_source: "user" })
    expect((await sessionOf(room, open.userId)).departed_at).toEqual(room.end)
    expect(again).toBe(0)
  })

  it("closes at most `limit` in one pass, the oldest room first", async () => {
    // This database is shared with every suite: drain what they left first, so
    // the two rooms below are the only strandable ones.
    await closeStrandedSessions(new Date(), 100_000)
    const older = await occurrence(3 * 24 * 60 + 180, 3 * 24 * 60)
    const newer = await occurrence(24 * 60 + 180, 24 * 60)
    // The newer room's session is written first, so an unordered scan finds it first.
    const b = await guest(newer, null)
    const a = await guest(older, null)

    expect(await closeStrandedSessions(new Date(), 1)).toBe(1)
    expect((await sessionOf(older, a.userId)).departed_at).not.toBeNull()
    expect((await sessionOf(newer, b.userId)).departed_at).toBeNull()
  })
})

describe("the sweep reaches them", () => {
  it("sweepPresence closes a stranded session and reports how many", async () => {
    const room = await occurrence(24 * 60 + 180, 24 * 60)
    const { userId } = await guest(room, "cancelled")

    const result = await sweepPresence()

    expect(result.stranded).toBeGreaterThanOrEqual(1)
    expect((await sessionOf(room, userId)).departed_at).toEqual(room.end)
  })
})
