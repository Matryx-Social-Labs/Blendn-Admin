import { insideNow, openSession, closeSession } from "@/lib/presence-sessions"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * The two sources must agree before either can be switched off.
 *
 * `presence_sessions` is written beside `event_check_ins` and backfilled from
 * it, and the plan's cutover moves occupancy and dwell onto sessions. That
 * switch changes the number an organiser watches live and the number a fire
 * officer is quoted, so the only responsible order is: prove they agree, then
 * move, then retire the old one.
 *
 * This is the proof, and it is deliberately written before any reader moves —
 * a reconciliation test added *after* a cutover only documents whatever the new
 * code happens to do.
 *
 * ## Why "distinct people" is the whole assertion
 *
 * The plan's own correction: sessions make a naive `_count` **worse**, not
 * better, because one row per person becomes several. The old table could be
 * counted by rows and be accidentally right; this one cannot. Every comparison
 * below is over distinct users for that reason, and the fixtures deliberately
 * contain somebody with two sessions so that a row-count and a person-count
 * cannot coincide.
 */

const users: string[] = []
const events: string[] = []
const MIN = 60_000

afterAll(async () => {
  if (events.length) {
    await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function liveRoom() {
  const owner = await makeUser(testId("rc_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("rc"),
      title: `Reconcile ${testId("t")}`,
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
  return { eventId: event.id, occurrenceId: occ.id }
}

/** Arrive through both writers, the way the check-in route does. */
async function arriveBoth(
  r: { eventId: string; occurrenceId: string },
  userId: string,
  at: Date,
  kind: "attendee" | "staff" = "attendee"
) {
  await db.event_check_ins.create({
    data: {
      event_id: r.eventId,
      occurrence_id: r.occurrenceId,
      user_id: userId,
      kind,
      status: "checked_in",
      check_in_time: at,
      last_seen_at: at,
    },
  })
  await openSession({ eventId: r.eventId, occurrenceId: r.occurrenceId, userId, kind, at })
}

/** The old fold: distinct guests currently checked in for this occurrence. */
async function insideByCheckIns(occurrenceId: string): Promise<number> {
  const [row] = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(DISTINCT user_id) AS n
    FROM event_check_ins
    WHERE occurrence_id = ${occurrenceId}::uuid
      AND status = 'checked_in'
      AND kind = 'attendee'
  `
  return Number(row?.n ?? 0)
}

describe("sessions and check-ins agree about who is inside", () => {
  it("matches for a plain room", async () => {
    const r = await liveRoom()
    const now = new Date()
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(testId(`rc_a${i}`))
      users.push(u)
      await arriveBoth(r, u, new Date(now.getTime() - 5 * MIN))
    }

    const [old_, next] = await Promise.all([
      insideByCheckIns(r.occurrenceId),
      insideNow(r.occurrenceId),
    ])
    // The control: a room of nobody would make agreement meaningless.
    expect(old_).toBe(3)
    expect(next).toBe(old_)
  })

  it("matches when somebody has left", async () => {
    const r = await liveRoom()
    const now = new Date()
    const stayed = await makeUser(testId("rc_stay"))
    const left = await makeUser(testId("rc_left"))
    users.push(stayed, left)

    /*
     * Five minutes, not thirty, and the difference is the point.
     *
     * The first draft had both arrive half an hour ago and never ping again.
     * The check-in row still said `checked_in`; sessions said nobody was there,
     * because `last_seen_at` was outside the ten-minute cutoff. That is the two
     * models disagreeing *correctly* — and it belongs in the test written for
     * that disagreement, not in the one asserting they agree.
     *
     * A live room has live heartbeats. Arriving inside the cutoff is what makes
     * this fixture a room rather than a stale row.
     */
    await arriveBoth(r, stayed, new Date(now.getTime() - 5 * MIN))
    await arriveBoth(r, left, new Date(now.getTime() - 5 * MIN))

    await db.event_check_ins.updateMany({
      where: { occurrence_id: r.occurrenceId, user_id: left },
      data: { status: "checked_out", check_out_time: now },
    })
    await closeSession(r.occurrenceId, left, "user", now)

    expect(await insideByCheckIns(r.occurrenceId)).toBe(1)
    expect(await insideNow(r.occurrenceId)).toBe(1)
  })

  it("matches when somebody came back — where row-counting would not", async () => {
    /*
     * The case that separates the two models. The old table holds one row for
     * this person however many times they came and went; the new one holds
     * three. Both must say "one person inside".
     *
     * A `COUNT(*)` over sessions would say two here if the partial unique were
     * missing, and this is the fixture that would catch it.
     */
    const r = await liveRoom()
    const now = new Date()
    const u = await makeUser(testId("rc_back"))
    users.push(u)

    await arriveBoth(r, u, new Date(now.getTime() - 90 * MIN))
    await closeSession(r.occurrenceId, u, "user", new Date(now.getTime() - 60 * MIN))
    await openSession({
      eventId: r.eventId,
      occurrenceId: r.occurrenceId,
      userId: u,
      at: new Date(now.getTime() - 30 * MIN),
    })
    await closeSession(r.occurrenceId, u, "user", new Date(now.getTime() - 20 * MIN))
    await openSession({
      eventId: r.eventId,
      occurrenceId: r.occurrenceId,
      userId: u,
      at: new Date(now.getTime() - 2 * MIN),
    })

    const sessionRows = await db.presence_sessions.count({
      where: { occurrence_id: r.occurrenceId, user_id: u },
    })
    const checkInRows = await db.event_check_ins.count({
      where: { occurrence_id: r.occurrenceId, user_id: u },
    })

    // Three sessions, one check-in row — the shapes genuinely differ.
    expect({ sessionRows, checkInRows }).toEqual({ sessionRows: 3, checkInRows: 1 })
    // And both answer the question the same way.
    expect(await insideByCheckIns(r.occurrenceId)).toBe(1)
    expect(await insideNow(r.occurrenceId)).toBe(1)
  })

  it("excludes staff from both, the same way", async () => {
    const r = await liveRoom()
    const now = new Date()
    const guest = await makeUser(testId("rc_g"))
    const crew = await makeUser(testId("rc_c"))
    users.push(guest, crew)

    await arriveBoth(r, guest, new Date(now.getTime() - 5 * MIN))
    await arriveBoth(r, crew, new Date(now.getTime() - 5 * MIN), "staff")

    expect(await insideByCheckIns(r.occurrenceId)).toBe(1)
    expect(await insideNow(r.occurrenceId)).toBe(1)
    // And both can count bodies when fire safety asks, rather than guests.
    expect(await insideNow(r.occurrenceId, { includeStaff: true })).toBe(2)
  })

  it("is where the two DISAGREE, and says so deliberately", async () => {
    /*
     * The one case they differ, recorded rather than smoothed over — it is the
     * reason to move, not a defect.
     *
     * A check-in row goes stale: the sweeper closes people on a timer and
     * anyone it misses stays `checked_in` forever, which is how occupancy
     * drifts upward across a multi-day run and never comes back down. Sessions
     * ask `last_seen_at > cutoff`, so silence stops counting on its own.
     *
     * The old fold still says one; the new one says none. That gap IS the
     * cutover's value, so it is asserted rather than reconciled away.
     */
    const r = await liveRoom()
    const stale = new Date(Date.now() - 60 * MIN)
    const u = await makeUser(testId("rc_stale"))
    users.push(u)
    await arriveBoth(r, u, stale)
    await db.presence_sessions.updateMany({
      where: { occurrence_id: r.occurrenceId, user_id: u },
      data: { last_seen_at: stale },
    })

    expect(await insideByCheckIns(r.occurrenceId)).toBe(1)
    expect(await insideNow(r.occurrenceId)).toBe(0)
  })
})
