import { getConnectionMetrics, MIN_ATTENDEES } from "@/lib/connection-metrics"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

/**
 * Did anyone meet anyone.
 *
 * Two failure modes matter more than the arithmetic. Counting a mutual pair
 * twice reads as a good event and is the easy mistake. Reporting at all on a
 * room of four names the people involved to anyone who was there.
 */

const users: string[] = []
const events: string[] = []

async function room(attendeeCount: number) {
  const host = await makeUser("cm-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)

  const occurrenceId = await occurrenceOf(eventId)
  const guests: string[] = []
  for (let i = 0; i < attendeeCount; i++) {
    const u = await makeUser(`cm-g${i}`)
    users.push(u)
    guests.push(u)
    await db.event_check_ins.create({
      data: {
        user_id: u,
        event_id: eventId,
        occurrence_id: occurrenceId,
        check_in_time: new Date(),
        status: "checked_in",
        kind: "attendee",
      },
    })
  }
  return { eventId, guests }
}

const like = (eventId: string, liker: string, liked: string) =>
  db.event_likes.create({ data: { event_id: eventId, liker_id: liker, liked_id: liked } })

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("a connection is mutual", () => {
  it("does not count a like nobody returned", async () => {
    // One-sided likes are private to whoever sent them. An organiser learning
    // how many went unreciprocated would be learning about individuals.
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await like(eventId, guests[0], guests[1])

    const m = await getConnectionMetrics(eventId)
    expect(m.connections).toBe(0)
    expect(m.connected).toBe(0)
  })

  it("counts a mutual pair exactly once", async () => {
    // The easy mistake: walking the likes and asking whether the reverse exists
    // counts every pair twice, which reads as a good event.
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await like(eventId, guests[0], guests[1])
    await like(eventId, guests[1], guests[0])

    const m = await getConnectionMetrics(eventId)
    expect(m.connections).toBe(1)
    expect(m.connected).toBe(2)
  })

  it("counts each person once however many connections they made", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    for (const other of [guests[1], guests[2]]) {
      await like(eventId, guests[0], other)
      await like(eventId, other, guests[0])
    }

    const m = await getConnectionMetrics(eventId)
    expect(m.connections).toBe(2)
    expect(m.connected).toBe(3)
  })
})

describe("the benchmark figures", () => {
  it("reports connections per attendee and the share who met someone", async () => {
    const { eventId, guests } = await room(10)
    // Two pairs among ten: 0.2 each, 40% met someone.
    await like(eventId, guests[0], guests[1])
    await like(eventId, guests[1], guests[0])
    await like(eventId, guests[2], guests[3])
    await like(eventId, guests[3], guests[2])

    const m = await getConnectionMetrics(eventId)
    expect(m).toMatchObject({ attendees: 10, connections: 2, connected: 4 })
    expect(m.perAttendee).toBe(0.2)
    expect(m.connectedPct).toBe(40)
  })

  it("reports a real zero for a room where nobody connected", async () => {
    // Distinct from suppression: this is a finding, not a withheld number.
    const { eventId } = await room(MIN_ATTENDEES)
    const m = await getConnectionMetrics(eventId)
    expect(m.suppressed).toBe(false)
    expect(m.connections).toBe(0)
    expect(m.connectedPct).toBe(0)
  })
})

describe("small rooms are suppressed", () => {
  it("withholds everything derived below the floor", async () => {
    // "One connection among three attendees" names both of them.
    const { eventId, guests } = await room(MIN_ATTENDEES - 1)
    await like(eventId, guests[0], guests[1])
    await like(eventId, guests[1], guests[0])

    const m = await getConnectionMetrics(eventId)
    expect(m.suppressed).toBe(true)
    expect(m.perAttendee).toBeNull()
    expect(m.connectedPct).toBeNull()
    expect(m.connections).toBe(0)
  })

  it("still reports how many attended", async () => {
    // Attendance is already on the page; withholding it here would be theatre.
    const { eventId } = await room(3)
    expect(await getConnectionMetrics(eventId)).toMatchObject({ attendees: 3, suppressed: true })
  })

  it("reports at exactly the floor", async () => {
    const { eventId } = await room(MIN_ATTENDEES)
    expect((await getConnectionMetrics(eventId)).suppressed).toBe(false)
  })
})

describe("who counts as an attendee", () => {
  it("ignores staff and people who never actually checked in", async () => {
    // Staff are not attendees, and an RSVP is not attendance — the denominator
    // has to match the one attendance uses or the two panels disagree.
    const { eventId } = await room(MIN_ATTENDEES)
    const occurrenceId = await occurrenceOf(eventId)

    const crew = await makeUser("cm-crew")
    const noshow = await makeUser("cm-noshow")
    users.push(crew, noshow)
    await db.event_check_ins.create({
      data: {
        user_id: crew,
        event_id: eventId,
        occurrence_id: occurrenceId,
        check_in_time: new Date(),
        status: "checked_in",
        kind: "staff",
      },
    })
    await db.event_check_ins.create({
      data: {
        user_id: noshow,
        event_id: eventId,
        occurrence_id: occurrenceId,
        check_in_time: null,
        status: "checked_out",
      },
    })

    expect((await getConnectionMetrics(eventId)).attendees).toBe(MIN_ATTENDEES)
  })
})
