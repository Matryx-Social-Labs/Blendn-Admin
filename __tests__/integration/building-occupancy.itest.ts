import { getBuildingOccupancy } from "@/lib/building-occupancy"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

/**
 * How many people are in the building.
 *
 * Per-event occupancy is the organiser's number. This is the venue owner's, and
 * the fire officer's: two events running at once are two correct figures and no
 * answer to "how many people are inside".
 */

const users: string[] = []
const events: string[] = []

async function venue(capacity: number | null) {
  const owner = await makeUser("bo-owner", "organizer")
  users.push(owner)
  const v = await db.venues.create({
    data: { name: `Venue ${Math.random().toString(36).slice(2, 8)}`, capacity, owner_id: owner },
  })
  return v.id
}

/** A published event at this venue, running right now unless told otherwise. */
async function roomAt(venueId: string, opts: { past?: boolean } = {}) {
  const host = await makeUser("bo-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const now = Date.now()
  await db.events.update({
    where: { id: eventId },
    data: {
      venue_id: venueId,
      status: "published",
      ...(opts.past
        ? { start_time: new Date(now - 3 * 3600_000), end_time: new Date(now - 2 * 3600_000) }
        : {}),
    },
  })
  return eventId
}

async function inside(eventId: string, kind: "attendee" | "staff", count: number) {
  const occurrenceId = await occurrenceOf(eventId)
  for (let i = 0; i < count; i++) {
    const u = await makeUser(`bo-${kind}`)
    users.push(u)
    await db.event_check_ins.create({
      data: {
        user_id: u,
        event_id: eventId,
        occurrence_id: occurrenceId,
        check_in_time: new Date(),
        status: "checked_in",
        kind,
      },
    })
  }
}

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("summing the rooms", () => {
  it("adds every event running now", async () => {
    const venueId = await venue(100)
    const [main, basement] = await Promise.all([roomAt(venueId), roomAt(venueId)])
    await inside(main, "attendee", 30)
    await inside(basement, "attendee", 12)

    const b = await getBuildingOccupancy(venueId)
    expect(b.inside).toBe(42)
    expect(b.rooms).toHaveLength(2)
    // Busiest first — the room worth looking at is the one at the top.
    expect(b.rooms[0].eventId).toBe(main)
  })

  it("counts staff toward the building, and splits them per room", async () => {
    // Fire safety counts bodies, not job titles — same rule as per-event
    // occupancy. The split stays so an owner still knows who is who.
    const venueId = await venue(100)
    const room = await roomAt(venueId)
    await inside(room, "attendee", 8)
    await inside(room, "staff", 3)

    const b = await getBuildingOccupancy(venueId)
    expect(b.inside).toBe(11)
    expect(b.rooms[0]).toMatchObject({ inside: 11, guestsInside: 8, staffInside: 3 })
  })

  it("ignores events that have already ended", async () => {
    // Their check-in rows still exist; the people do not.
    const venueId = await venue(100)
    const over = await roomAt(venueId, { past: true })
    await inside(over, "attendee", 40)

    const b = await getBuildingOccupancy(venueId)
    expect(b.inside).toBe(0)
    expect(b.rooms).toEqual([])
  })
})

describe("against the venue's own capacity", () => {
  it("flags a building over its licence even when each room is under its own", async () => {
    // The case the per-event number cannot express: two rooms, each comfortably
    // within its own capacity, and a building past what it is licensed for.
    const venueId = await venue(50)
    const [a, b2] = await Promise.all([roomAt(venueId), roomAt(venueId)])
    await db.events.update({ where: { id: a }, data: { max_capacity: 40 } })
    await db.events.update({ where: { id: b2 }, data: { max_capacity: 40 } })
    await inside(a, "attendee", 30)
    await inside(b2, "attendee", 30)

    const b = await getBuildingOccupancy(venueId)
    expect(b.inside).toBe(60)
    expect(b.overCapacity).toBe(true)
    expect(b.fillPct).toBe(120)
  })

  it("does not clamp fill at 100", async () => {
    // Clamping is what made an over-capacity room unrepresentable on the event
    // screen. The same mistake is available here.
    const venueId = await venue(10)
    const room = await roomAt(venueId)
    await inside(room, "attendee", 25)

    expect((await getBuildingOccupancy(venueId)).fillPct).toBe(250)
  })

  it("reports null fill when the venue states no capacity", async () => {
    // Defaulting to 0% would draw an empty bar on a packed building.
    const venueId = await venue(null)
    const room = await roomAt(venueId)
    await inside(room, "attendee", 5)

    const b = await getBuildingOccupancy(venueId)
    expect(b.fillPct).toBeNull()
    expect(b.overCapacity).toBe(false)
    expect(b.inside).toBe(5)
  })
})

describe("a quiet venue", () => {
  it("returns an empty building rather than throwing", async () => {
    const b = await getBuildingOccupancy(await venue(100))
    expect(b).toMatchObject({ inside: 0, rooms: [], overCapacity: false })
  })
})
