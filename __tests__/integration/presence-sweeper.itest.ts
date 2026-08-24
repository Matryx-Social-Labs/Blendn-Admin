// `performCheckout` emits a socket event, which pulls in socket-server ->
// mobile-auth -> jose. `jose` is pure ESM with no CommonJS build and Jest
// cannot load it. Free in production, where server.ts loads socket-server
// anyway; stubbed here so the sweeper can be tested at all.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { sweepPresence, MASS_CHECKOUT_THRESHOLD, MASS_CHECKOUT_FLOOR } from "@/lib/presence-sweeper"
import { getOccupancy } from "@/lib/occupancy"
import { DEPARTURE_GRACE_MINUTES, DEPARTURE_ALLOWANCE_MINUTES } from "@/lib/presence"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * The sweeper, against real rows.
 *
 * `lib/presence.ts` decides and is unit-tested; this checks the applying —
 * idempotency, the mass-checkout guard, and the fact that silence never empties
 * a room mid-event.
 */

const users: string[] = []
const events: string[] = []

const LAT = 12.9784
const LNG = 77.6408
const FENCE = { type: "circle", lat: LAT, lng: LNG, radius: 40, buffer: 20 }

afterAll(async () => {
  if (events.length) {
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

const ago = (mins: number) => new Date(Date.now() - mins * 60_000)

async function liveEvent() {
  const owner = await makeUser(testId("sw_own"), "organizer")
  users.push(owner)
  const event = await db.events.create({
    data: {
      slug: testId("sw"),
      title: "Sweeper fixture",
      description: "integration fixture",
      start_time: ago(60),
      end_time: new Date(Date.now() + 3 * 60 * 60_000),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: owner,
      latitude: LAT,
      longitude: LNG,
      geofence: FENCE,
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

async function present(
  eventId: string,
  occurrenceId: string,
  label: string,
  over: Partial<{
    kind: "attendee" | "staff"
    left_area_at: Date | null
    departure_prompted_at: Date | null
    last_seen_at: Date | null
  }> = {}
) {
  const userId = await makeUser(testId(label))
  users.push(userId)
  return db.event_check_ins.create({
    data: {
      event_id: eventId,
      occurrence_id: occurrenceId,
      user_id: userId,
      status: "checked_in",
      check_in_time: ago(60),
      kind: over.kind ?? "attendee",
      left_area_at: over.left_area_at ?? null,
      departure_prompted_at: over.departure_prompted_at ?? null,
      last_seen_at: over.last_seen_at ?? ago(5),
    },
  })
}

describe("the sweeper acts on time passing", () => {
  it("leaves someone alone while the allowance is still running", async () => {
    /*
     * This used to assert a prompt. The prompt wrote a timestamp and notified
     * nobody, so the sweeper recorded `no_response` to a question never asked;
     * it is gone, and the twenty-minute total tolerance is unchanged.
     */
    const { eventId, occurrenceId } = await liveEvent()
    // Four inside; only one has been out long enough. One in four is exactly at
    // the guard threshold, not over it.
    const out = await present(eventId, occurrenceId, "p1", {
      left_area_at: ago(DEPARTURE_GRACE_MINUTES + 5),
    })
    await present(eventId, occurrenceId, "p2")
    await present(eventId, occurrenceId, "p3")
    await present(eventId, occurrenceId, "p4")

    await sweepPresence()

    const row = await db.event_check_ins.findUniqueOrThrow({ where: { id: out.id } })
    // Past the grace, inside the allowance: still counted.
    expect(row.status).toBe("checked_in")
  })

  it("checks out someone who never answered the prompt", async () => {
    const { eventId, occurrenceId } = await liveEvent()
    const gone = await present(eventId, occurrenceId, "g1", {
      left_area_at: ago(120),
      departure_prompted_at: ago(DEPARTURE_ALLOWANCE_MINUTES + 5),
    })
    for (const l of ["g2", "g3", "g4", "g5"]) await present(eventId, occurrenceId, l)

    await sweepPresence()
    const row = await db.event_check_ins.findUniqueOrThrow({ where: { id: gone.id } })
    expect(row.status).toBe("checked_out")
    expect(row.check_out_time).not.toBeNull()
    expect((await getOccupancy(eventId)).inside).toBe(4)
  })

  it("is idempotent — a second pass changes nothing", async () => {
    // The sweeper runs every five minutes and must not care what the last pass
    // did.
    const { eventId, occurrenceId } = await liveEvent()
    await present(eventId, occurrenceId, "i1", {
      left_area_at: ago(120),
      departure_prompted_at: ago(DEPARTURE_ALLOWANCE_MINUTES + 5),
    })
    for (const l of ["i2", "i3", "i4", "i5"]) await present(eventId, occurrenceId, l)

    const first = await sweepPresence()
    const second = await sweepPresence()
    expect(first.checkedOut).toBe(1)
    expect(second.checkedOut).toBe(0)
    expect((await getOccupancy(eventId)).inside).toBe(4)
  })

  it("leaves alone anyone still inside", async () => {
    const { eventId, occurrenceId } = await liveEvent()
    await present(eventId, occurrenceId, "in1")
    await present(eventId, occurrenceId, "in2")
    const result = await sweepPresence()
    expect(result.checkedOut).toBe(0)
    expect((await getOccupancy(eventId)).inside).toBe(2)
  })
})

describe("the mass-checkout guard", () => {
  it("acts on NOBODY when too much of a real crowd would go at once", async () => {
    // A venue whose wifi dies produces a burst of out-of-fence readings that
    // look exactly like everyone leaving. Emptying the room on the organiser's
    // screen would read as an evacuation.
    const { eventId, occurrenceId } = await liveEvent()
    // Six of eight — over the share, and enough people for the share to mean
    // something. This case used to be three of four; see the test below for why
    // that is no longer guarded.
    for (const l of ["m1", "m2", "m3", "m4", "m5", "m6"]) {
      await present(eventId, occurrenceId, l, { left_area_at: ago(120) })
    }
    for (const l of ["m7", "m8"]) await present(eventId, occurrenceId, l)

    const result = await sweepPresence()
    expect(result.guarded).toContain(eventId)
    expect(result.checkedOut).toBe(0)
    // Everyone still counted. The organiser gets an alert, not a wrong number.
    expect((await getOccupancy(eventId)).inside).toBe(8)
  })

  it("does NOT guard a small room, however large the share", async () => {
    /*
     * The fix, and the reason the test above had to change.
     *
     * The share alone made auto-checkout unreachable in a small room. One
     * person leaving a room of two is 100%; three of four is 75%; both used to
     * trip a 25% threshold. So at a book club nobody was ever closed out and
     * occupancy only climbed — and at the end of EVERY event, when everyone
     * leaves at once, the guard tripped by construction and the room never
     * emptied.
     *
     * The guard is about a venue-wide signal failure, which is a phenomenon of
     * crowds. Three people leaving a room of four is three people leaving.
     */
    const { eventId, occurrenceId } = await liveEvent()
    for (const l of ["s1", "s2", "s3"]) {
      await present(eventId, occurrenceId, l, { left_area_at: ago(120) })
    }
    await present(eventId, occurrenceId, "s4")

    const result = await sweepPresence()
    expect(result.guarded).not.toContain(eventId)
    expect(result.checkedOut).toBe(3)
    expect((await getOccupancy(eventId)).inside).toBe(1)
  })

  it("does not trip below the threshold", async () => {
    const { eventId, occurrenceId } = await liveEvent()
    await present(eventId, occurrenceId, "t1", {
      left_area_at: ago(120),
      departure_prompted_at: ago(DEPARTURE_ALLOWANCE_MINUTES + 5),
    })
    for (const l of ["t2", "t3", "t4", "t5", "t6"]) await present(eventId, occurrenceId, l)

    // 1 of 6 is under 25%.
    const result = await sweepPresence()
    expect(result.guarded).not.toContain(eventId)
    expect(result.checkedOut).toBe(1)
  })

  it("has a threshold that is a share AND a floor that is a count", () => {
    /*
     * Both, because either alone is wrong. A share with no floor cannot tell a
     * small room from a failing venue; a count with no share would trip on five
     * people leaving a festival.
     */
    expect(MASS_CHECKOUT_THRESHOLD).toBeGreaterThan(0)
    expect(MASS_CHECKOUT_THRESHOLD).toBeLessThan(1)
    expect(MASS_CHECKOUT_FLOOR).toBeGreaterThan(1)
    expect(Number.isInteger(MASS_CHECKOUT_FLOOR)).toBe(true)
  })
})

describe("silence never empties a room mid-event", () => {
  it("leaves everyone alone when nobody has pinged for hours", async () => {
    // The failure this whole design guards against. No ping means a backgrounded
    // app, a basement, a dead battery — not an empty room.
    const { eventId, occurrenceId } = await liveEvent()
    for (const l of ["s1", "s2", "s3"]) {
      await present(eventId, occurrenceId, l, { last_seen_at: ago(240) })
    }

    const result = await sweepPresence()
    expect(result.checkedOut).toBe(0)
    expect((await getOccupancy(eventId)).inside).toBe(3)
  })
})

describe("staff", () => {
  it("are not swept out mid-event, however long they have been outside", async () => {
    const { eventId, occurrenceId } = await liveEvent()
    const crew = await present(eventId, occurrenceId, "crew", {
      kind: "staff",
      left_area_at: ago(180),
      departure_prompted_at: ago(120),
    })
    for (const l of ["c2", "c3", "c4"]) await present(eventId, occurrenceId, l)

    await sweepPresence()
    const row = await db.event_check_ins.findUniqueOrThrow({ where: { id: crew.id } })
    expect(row.status).toBe("checked_in")
  })
})
