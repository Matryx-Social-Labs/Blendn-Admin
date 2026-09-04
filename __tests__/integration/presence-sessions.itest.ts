import {
  openSession,
  closeSession,
  insideNow,
  dwellSeconds,
  attended,
  departureQuality,
  headcount,
} from "@/lib/presence-sessions"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * Leaving and coming back.
 *
 * `event_check_ins` holds one mutable row per person per occurrence, so a
 * re-entry has nowhere to go: it must overwrite the arrival. "They arrived at
 * 8, left at 9, came back at 10" is not a thing that shape can hold, and every
 * dwell figure built on it counts the hour at the pub as time in the room.
 *
 * These tests are mostly about *many rows for one person* being correct, which
 * is the half that gets worse before it gets better: the plan's own correction
 * says a naive `_count` is more wrong after this change, not less, because one
 * row per person becomes several. Every count here is over distinct people for
 * that reason.
 *
 * Against real Postgres because the load-bearing constraint cannot be expressed
 * in `schema.prisma` and therefore does not exist in a `db push` database —
 * only one session may be OPEN per person per occurrence, as a partial unique.
 * A mocked test would assert the query and miss the guarantee entirely.
 */

const users: string[] = []
const events: string[] = []
const MIN = 60_000

afterAll(async () => {
  if (events.length) {
    await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function room() {
  const owner = await makeUser(testId("ps_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("ps"),
      title: `Presence ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(now - 60 * MIN),
      end_time: new Date(now + 180 * MIN),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  const occ = await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
  })
  const person = await makeUser(testId("ps_p"))
  users.push(person)
  return { eventId: event.id, occurrenceId: occ.id, person }
}

const arrive = (r: { eventId: string; occurrenceId: string }, u: string, at: Date) =>
  openSession({ eventId: r.eventId, occurrenceId: r.occurrenceId, userId: u, at })

describe("a session per visit, not a status per person", () => {
  it("records a re-entry as a second session, leaving the first arrival intact", async () => {
    /*
     * The property the old shape cannot hold. Under `event_check_ins` the
     * second arrival would overwrite `check_in_time`, and 20:00 would be lost.
     */
    const r = await room()
    const eight = new Date(Date.now() - 120 * MIN)
    const nine = new Date(Date.now() - 90 * MIN)
    const ten = new Date(Date.now() - 30 * MIN)

    await arrive(r, r.person, eight)
    await closeSession(r.occurrenceId, r.person, "user", nine)
    await arrive(r, r.person, ten)

    const sessions = await db.presence_sessions.findMany({
      where: { occurrence_id: r.occurrenceId, user_id: r.person },
      orderBy: { arrived_at: "asc" },
      select: { arrived_at: true, departed_at: true, departed_source: true },
    })

    expect(sessions).toHaveLength(2)
    expect(sessions[0].arrived_at.getTime()).toBe(eight.getTime())
    expect(sessions[0].departed_at?.getTime()).toBe(nine.getTime())
    expect(sessions[0].departed_source).toBe("user")
    // The first arrival survived the second, which is the whole point.
    expect(sessions[1].arrived_at.getTime()).toBe(ten.getTime())
    expect(sessions[1].departed_at).toBeNull()
  })

  it("counts one person inside, not one per session", async () => {
    /*
     * The row-versus-person error, in the table built to fix it. Somebody who
     * stepped out and came back has two sessions and is one body.
     */
    const r = await room()
    await arrive(r, r.person, new Date(Date.now() - 120 * MIN))
    await closeSession(r.occurrenceId, r.person, "user", new Date(Date.now() - 90 * MIN))
    await arrive(r, r.person, new Date(Date.now() - 2 * MIN))

    expect(await db.presence_sessions.count({ where: { occurrence_id: r.occurrenceId } })).toBe(2)
    expect(await insideNow(r.occurrenceId)).toBe(1)
  })

  it("refuses to hold two open sessions for one person", async () => {
    /*
     * The invariant that only exists in the migration. Many sessions per pair
     * is the point; two OPEN at once means occupancy counts one body twice —
     * the failure this model removes, walking back in through the door marked
     * "many sessions are allowed".
     *
     * `openSession` guards it in code for the ordinary path. This asserts the
     * database refuses it regardless, which is what survives a race between two
     * concurrent check-in requests.
     */
    const r = await room()
    await arrive(r, r.person, new Date(Date.now() - 30 * MIN))

    await expect(
      db.presence_sessions.create({
        data: {
          event_id: r.eventId,
          occurrence_id: r.occurrenceId,
          user_id: r.person,
          arrived_at: new Date(),
        },
      })
    ).rejects.toThrow()

    // And the legitimate case still works: a CLOSED session beside an open one.
    await db.presence_sessions.create({
      data: {
        event_id: r.eventId,
        occurrence_id: r.occurrenceId,
        user_id: r.person,
        arrived_at: new Date(Date.now() - 200 * MIN),
        departed_at: new Date(Date.now() - 190 * MIN),
        departed_source: "user",
      },
    })
    expect(await db.presence_sessions.count({ where: { occurrence_id: r.occurrenceId } })).toBe(2)
  })

  it("is idempotent when somebody checks in twice without leaving", async () => {
    const r = await room()
    const first = await arrive(r, r.person, new Date(Date.now() - 30 * MIN))
    const second = await arrive(r, r.person, new Date(Date.now() - 1 * MIN))

    expect(second.id).toBe(first.id)
    expect(await db.presence_sessions.count({ where: { occurrence_id: r.occurrenceId } })).toBe(1)
    // The heartbeat moved even though no session was opened.
    expect(second.last_seen_at!.getTime()).toBeGreaterThan(first.arrived_at.getTime())
  })

  it("excludes time spent outside from dwell", async () => {
    /*
     * The reason dwell needs sessions at all. With one row it can only be
     * `check_out_time - check_in_time`, which bills the hour at the pub as time
     * in the room.
     */
    const r = await room()
    const t = (m: number) => new Date(Date.now() - m * MIN)
    await arrive(r, r.person, t(120))
    await closeSession(r.occurrenceId, r.person, "user", t(100)) // 20 min inside
    await arrive(r, r.person, t(40))
    await closeSession(r.occurrenceId, r.person, "user", t(30)) // 10 min inside

    // 30 minutes present across a 90-minute span.
    expect(await dwellSeconds(r.occurrenceId, r.person)).toBe(30 * 60)
  })

  it("keeps counting somebody whose heartbeat went silent, and says the number is inferred", async () => {
    /*
     * REVERSED, deliberately, and this is the one decision in the cutover
     * worth arguing.
     *
     * This asserted that 45 minutes of silence empties a room, reasoning that
     * `departed_at IS NULL` is evidence only that nothing closed the session —
     * which is what a stalled sweeper produces, and occupancy climbing forever
     * is the bug being replaced.
     *
     * The reasoning is sound and the premise is false. It requires silence to
     * be informative. The Expo client polls in the FOREGROUND ONLY, because it
     * refuses iOS `Always` permission on purpose as an App Review liability.
     * A phone that goes into a pocket stops reporting within minutes, and at a
     * real event most phones are in pockets most of the time. A ten-minute
     * cutoff does not drain a stale room; it drains a full one.
     *
     * Both failure modes are real and they are not symmetric. A stalled
     * sweeper leaves the figure VISIBLY uncertain: `stale` says how much of it
     * is inference, and the sweeper has a cron fallback. A silence cutoff makes
     * it SILENTLY wrong, in the direction of telling a fire officer that a room
     * with three hundred people in it is empty.
     *
     * What the cutover is actually worth is unchanged and tested elsewhere:
     * re-entry is representable, dwell excludes time outside, `departed_source`
     * records how a session ended, and people are counted rather than rows.
     * "Silence stops counting" was never one of those.
     */
    const r = await room()
    await arrive(r, r.person, new Date(Date.now() - 60 * MIN))
    await db.presence_sessions.updateMany({
      where: { occurrence_id: r.occurrenceId, user_id: r.person },
      data: { last_seen_at: new Date(Date.now() - 45 * MIN) },
    })

    // Still in the room: nothing has said they left.
    expect(await insideNow(r.occurrenceId)).toBe(1)

    // But the figure knows it is inferring, and can say so where it is shown.
    const h = await headcount({ occurrenceId: r.occurrenceId })
    expect(h.insideGuests).toBe(1)
    expect(h.stale).toBe(1)

    // A definite signal still removes them. Departure is decided, never assumed.
    await closeSession(r.occurrenceId, r.person, "sweeper")
    expect(await insideNow(r.occurrenceId)).toBe(0)
    expect(await attended(r.occurrenceId, r.person)).toBe(true)
  })

  it("says when the occupancy figure is mostly inference", async () => {
    /*
     * R31: a number nobody can trust should say so where it is shown, rather
     * than looking exactly like one that can be.
     */
    const r = await room()
    const t = (m: number) => new Date(Date.now() - m * MIN)
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(testId(`ps_sw${i}`))
      users.push(u)
      await arrive(r, u, t(60))
      await closeSession(r.occurrenceId, u, "sweeper", t(30))
    }
    await arrive(r, r.person, t(60))
    await closeSession(r.occurrenceId, r.person, "user", t(30))

    const q = await departureQuality(r.occurrenceId)
    expect({ closed: q.closed, bySweeper: q.bySweeper, degraded: q.degraded }).toEqual({
      closed: 4,
      bySweeper: 3,
      degraded: true,
    })
  })
})
