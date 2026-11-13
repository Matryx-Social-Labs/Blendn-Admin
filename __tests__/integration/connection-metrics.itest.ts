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

const wave = (eventId: string, from: string, to: string) =>
  db.event_waves.create({ data: { event_id: eventId, from_id: from, to_id: to } })

/** A Lobby ask from `from` on a post by `to`, in the given state. */
async function ask(eventId: string, from: string, to: string, status: "pending" | "accepted" | "declined" = "accepted") {
  const post = await db.board_posts.create({ data: { event_id: eventId, author_id: to, kind: "offer", body: "Two seats in the car", spaces_left: 2 } })
  await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: from, to_user_id: to, status, decided_at: status === "pending" ? null : new Date() } })
}

/** A message request between two people, met at `metIn` (or nowhere). */
const request = (sender: string, recipient: string, metIn: string | null, status: "pending" | "accepted" = "accepted") =>
  db.message_requests.create({ data: { sender_id: sender, recipient_id: recipient, met_in_event_id: metIn, status } })

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

describe("a connection is any way two people met here, once per pair (approval 1)", () => {
  it("counts mutual waves, and not a wave nobody returned", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await wave(eventId, guests[0], guests[1])
    await wave(eventId, guests[1], guests[0])
    // The control: a one-sided wave is as private as a one-sided like.
    await wave(eventId, guests[2], guests[3])

    expect(await getConnectionMetrics(eventId)).toMatchObject({ connections: 1, connected: 2 })
  })

  it("counts a like answered by a wave, as the app opens a match for it", async () => {
    // An old like is a hidden wave (approval 11, `openIfMutual`): either answers the other.
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await like(eventId, guests[0], guests[1])
    await wave(eventId, guests[1], guests[0])

    expect(await getConnectionMetrics(eventId)).toMatchObject({ connections: 1, connected: 2 })
  })

  it("counts an accepted Lobby ask, and not one still pending or declined", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await ask(eventId, guests[0], guests[1], "accepted")
    await ask(eventId, guests[2], guests[3], "pending")
    await ask(eventId, guests[4], guests[5], "declined")

    expect(await getConnectionMetrics(eventId)).toMatchObject({ connections: 1, connected: 2 })
  })

  it("counts an accepted message request met at this event, and not one met elsewhere or still pending", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    const { eventId: elsewhere } = await room(0)
    await request(guests[0], guests[1], eventId)
    await request(guests[2], guests[3], elsewhere)
    await request(guests[4], guests[5], null)
    await request(guests[6], guests[7], eventId, "pending")

    expect(await getConnectionMetrics(eventId)).toMatchObject({ connections: 1, connected: 2 })
  })

  it("counts a pair once however many ways they met", async () => {
    // The easy mistake across kinds: a pair who waved, shared a ride and then
    // accepted a request reads as three connections.
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await wave(eventId, guests[0], guests[1])
    await wave(eventId, guests[1], guests[0])
    await like(eventId, guests[0], guests[1])
    await like(eventId, guests[1], guests[0])
    await ask(eventId, guests[1], guests[0])
    await request(guests[0], guests[1], eventId)
    // The control: a different pair, one way only, still counts.
    await ask(eventId, guests[2], guests[3])

    const m = await getConnectionMetrics(eventId)
    expect(m).toMatchObject({ connections: 2, connected: 4 })
    expect(m.perAttendee).toBe(0.5)
  })

  it("still counts mutual likes on an event from before the Wave build", async () => {
    // Pre-Wave events hold likes only (approval 11: no like is migrated).
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await like(eventId, guests[0], guests[1])
    await like(eventId, guests[1], guests[0])

    expect(await getConnectionMetrics(eventId)).toMatchObject({ connections: 1, connected: 2 })
  })

  it("counts only pairs of people who attended", async () => {
    // The denominator is attendees, so "met someone" cannot pass 100% or count
    // a ride share with somebody who never came.
    const { eventId, guests } = await room(MIN_ATTENDEES)
    const noshow = await makeUser("cm-noshow-ask")
    users.push(noshow)
    await ask(eventId, noshow, guests[0])

    expect(await getConnectionMetrics(eventId)).toMatchObject({ connections: 0, connected: 0 })
  })

  it("returns counts only: hosts never see a pair or a person", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await wave(eventId, guests[0], guests[1])
    await wave(eventId, guests[1], guests[0])

    const m = await getConnectionMetrics(eventId)
    expect(Object.keys(m).sort()).toEqual(["attendees", "connected", "connectedPct", "connections", "perAttendee", "suppressed"])
    for (const v of Object.values(m)) expect(typeof v === "number" || typeof v === "boolean" || v === null).toBe(true)
  })
})

describe("the benchmark figures", () => {
  it("reports connections per attendee and the share who met someone", async () => {
    const { eventId, guests } = await room(10)
    // Two pairs among ten: each pair is a connection for BOTH people in it, so
    // four connections held among ten people is 0.4 each (F2: it read 0.2,
    // pairs per head, half the benchmark it is compared against), and 40% met
    // someone.
    await like(eventId, guests[0], guests[1])
    await like(eventId, guests[1], guests[0])
    await like(eventId, guests[2], guests[3])
    await like(eventId, guests[3], guests[2])

    const m = await getConnectionMetrics(eventId)
    expect(m).toMatchObject({ attendees: 10, connections: 2, connected: 4 })
    expect(m.perAttendee).toBe(0.4)
    expect(m.connectedPct).toBe(40)
  })

  it("counts per person from each person's own connections, not from the pair count", async () => {
    // The control for the line above: one person in three pairs. The pair
    // count is 3; the connections people hold are 6 (3 for the hub, 1 each for
    // the other three), so 6 / 10 = 0.6. Pairs per head would say 0.3, and
    // "connected people / attendees" would say 0.4 — only the right formula
    // gives 0.6.
    const { eventId, guests } = await room(10)
    for (const other of [guests[1], guests[2], guests[3]]) {
      await like(eventId, guests[0], other)
      await like(eventId, other, guests[0])
    }

    const m = await getConnectionMetrics(eventId)
    expect(m).toMatchObject({ attendees: 10, connections: 3, connected: 4 })
    expect(m.perAttendee).toBe(0.6)
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
