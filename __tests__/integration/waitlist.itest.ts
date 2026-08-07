import { placeRsvp, promoteFromWaitlist } from "@/lib/waitlist"

import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"

/**
 * The waitlist against a real database.
 *
 * The ordering and the promotion race are the parts a unit test cannot reach,
 * and they are the parts someone notices: being promoted out of turn, or two
 * people promoted into one seat.
 */

jest.mock("@/lib/push-notifications", () => ({
  sendPushNotification: jest.fn(async () => true),
}))

const users: string[] = []
const events: string[] = []

async function eventWithCapacity(capacity: number | null) {
  const host = await makeUser("wl-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { max_capacity: capacity } })
  return eventId
}

async function guest(label: string) {
  const id = await makeUser(label)
  users.push(id)
  return id
}

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("filling an event", () => {
  it("takes people until it is full, then waitlists", async () => {
    const eventId = await eventWithCapacity(2)
    const [a, b, c] = await Promise.all([guest("wl-a"), guest("wl-b"), guest("wl-c")])

    expect((await placeRsvp(eventId, a, "going")).status).toBe("going")
    expect((await placeRsvp(eventId, b, "going")).status).toBe("going")
    expect((await placeRsvp(eventId, c, "going")).status).toBe("waitlisted")
  })

  it("does not cost you your seat when you re-confirm", async () => {
    // Counting your own row against you is what a naive "count, then place"
    // does — and it would move someone already going onto the waitlist for
    // pressing the button twice.
    const eventId = await eventWithCapacity(1)
    const a = await guest("wl-d")

    expect((await placeRsvp(eventId, a, "going")).status).toBe("going")
    expect((await placeRsvp(eventId, a, "going")).status).toBe("going")
  })

  it("never waitlists when no capacity is set", async () => {
    const eventId = await eventWithCapacity(null)
    for (const label of ["wl-e", "wl-f", "wl-g"]) {
      expect((await placeRsvp(eventId, await guest(label), "going")).status).toBe("going")
    }
  })
})

describe("releasing a seat", () => {
  it("promotes the person who waited longest", async () => {
    // Any other order is unfair in a way someone notices and nobody can explain.
    const eventId = await eventWithCapacity(1)
    const [a, first, second] = await Promise.all([guest("wl-h"), guest("wl-i"), guest("wl-j")])

    await placeRsvp(eventId, a, "going")
    await placeRsvp(eventId, first, "going")
    await placeRsvp(eventId, second, "going")

    await placeRsvp(eventId, a, "not_going")

    const rows = await db.event_rsvps.findMany({
      where: { event_id: eventId },
      select: { user_id: true, status: true },
    })
    expect(rows.find((r) => r.user_id === first)?.status).toBe("going")
    expect(rows.find((r) => r.user_id === second)?.status).toBe("waitlisted")
  })

  it("promotes on cancellation too", async () => {
    const eventId = await eventWithCapacity(1)
    const [a, b] = await Promise.all([guest("wl-k"), guest("wl-l")])

    await placeRsvp(eventId, a, "going")
    await placeRsvp(eventId, b, "going")

    await db.event_rsvps.deleteMany({ where: { event_id: eventId, user_id: a } })
    expect(await promoteFromWaitlist(eventId)).toEqual([b])
  })

  it("promotes exactly as many as there are seats", async () => {
    const eventId = await eventWithCapacity(2)
    const [a, b, c, d] = await Promise.all([
      guest("wl-m"),
      guest("wl-n"),
      guest("wl-o"),
      guest("wl-p"),
    ])
    for (const u of [a, b, c, d]) await placeRsvp(eventId, u, "going")

    await db.event_rsvps.deleteMany({ where: { event_id: eventId, user_id: a } })
    expect(await promoteFromWaitlist(eventId)).toHaveLength(1)
    expect(await db.event_rsvps.count({ where: { event_id: eventId, status: "going" } })).toBe(2)
  })

  it("cannot promote the same person twice under a concurrent release", async () => {
    // Two cancellations landing together used to be the shape that
    // double-promotes: read the list, then write it. The conditional update
    // makes the second attempt match nothing.
    const eventId = await eventWithCapacity(1)
    const [a, b] = await Promise.all([guest("wl-q"), guest("wl-r")])
    await placeRsvp(eventId, a, "going")
    await placeRsvp(eventId, b, "going")
    await db.event_rsvps.deleteMany({ where: { event_id: eventId, user_id: a } })

    const [first, second] = await Promise.all([
      promoteFromWaitlist(eventId),
      promoteFromWaitlist(eventId),
    ])
    expect([...first, ...second]).toEqual([b])
  })

  it("promotes nobody into an over-subscribed event", async () => {
    // Capacity can be lowered after people said yes.
    const eventId = await eventWithCapacity(3)
    const [a, b, c] = await Promise.all([guest("wl-s"), guest("wl-t"), guest("wl-u")])
    for (const u of [a, b, c]) await placeRsvp(eventId, u, "going")

    await db.events.update({ where: { id: eventId }, data: { max_capacity: 1 } })
    const extra = await guest("wl-v")
    await placeRsvp(eventId, extra, "going")

    expect(await promoteFromWaitlist(eventId)).toEqual([])
  })
})
