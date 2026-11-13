import { connectionCounts, MIN_ATTENDEES } from "@/lib/connection-metrics"
import { eventInsights } from "@/lib/event-insights"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

/**
 * Did anyone meet anyone.
 *
 * Two failure modes matter more than the arithmetic. Counting a mutual pair
 * twice reads as a good event and is the easy mistake. Reporting at all on a
 * room of four names the people involved to anyone who was there.
 */

/** The funnel as the organiser's Overview gets it (Post A's reader), with every floor applied. */
const funnelOf = async (eventId: string) => (await eventInsights(eventId)).funnel

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

const wave = (eventId: string, from: string, to: string, at?: Date) =>
  db.event_waves.create({ data: { event_id: eventId, from_id: from, to_id: to, ...(at && { created_at: at }) } })

/** A Lobby ask from `from` on a post by `to`, in the given state. */
async function ask(eventId: string, from: string, to: string, status: "pending" | "accepted" | "declined" = "accepted", at = new Date()) {
  const post = await db.board_posts.create({ data: { event_id: eventId, author_id: to, kind: "offer", body: "Two seats in the car", spaces_left: 2 } })
  await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: from, to_user_id: to, status, decided_at: status === "pending" ? null : at } })
}

/** A message request between two people, met at `metIn` (or nowhere). */
const request = (sender: string, recipient: string, metIn: string | null, status: "pending" | "accepted" = "accepted", at?: Date) =>
  db.message_requests.create({ data: { sender_id: sender, recipient_id: recipient, met_in_event_id: metIn, status, ...(at && { responded_at: at }) } })

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

    const m = await connectionCounts(eventId)
    expect(m.connections).toBe(0)
    expect(m.connected).toBe(0)
  })

  it("counts a mutual pair exactly once", async () => {
    // The easy mistake: walking the likes and asking whether the reverse exists
    // counts every pair twice, which reads as a good event.
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await like(eventId, guests[0], guests[1])
    await like(eventId, guests[1], guests[0])

    const m = await connectionCounts(eventId)
    expect(m.connections).toBe(1)
    expect(m.connected).toBe(2)
  })

  it("counts each person once however many connections they made", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    for (const other of [guests[1], guests[2]]) {
      await like(eventId, guests[0], other)
      await like(eventId, other, guests[0])
    }

    const m = await connectionCounts(eventId)
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

    expect(await connectionCounts(eventId)).toMatchObject({ connections: 1, connected: 2 })
  })

  it("counts a like answered by a wave, as the app opens a match for it", async () => {
    // An old like is a hidden wave (approval 11, `openIfMutual`): either answers the other.
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await like(eventId, guests[0], guests[1])
    await wave(eventId, guests[1], guests[0])

    expect(await connectionCounts(eventId)).toMatchObject({ connections: 1, connected: 2 })
  })

  it("counts an accepted Lobby ask, and not one still pending or declined", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await ask(eventId, guests[0], guests[1], "accepted")
    await ask(eventId, guests[2], guests[3], "pending")
    await ask(eventId, guests[4], guests[5], "declined")

    expect(await connectionCounts(eventId)).toMatchObject({ connections: 1, connected: 2 })
  })

  it("counts an accepted message request met at this event, and not one met elsewhere or still pending", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    const { eventId: elsewhere } = await room(0)
    await request(guests[0], guests[1], eventId)
    await request(guests[2], guests[3], elsewhere)
    await request(guests[4], guests[5], null)
    await request(guests[6], guests[7], eventId, "pending")

    expect(await connectionCounts(eventId)).toMatchObject({ connections: 1, connected: 2 })
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

    expect(await connectionCounts(eventId)).toMatchObject({ connections: 2, connected: 4 })
  })

  it("still counts mutual likes on an event from before the Wave build", async () => {
    // Pre-Wave events hold likes only (approval 11: no like is migrated).
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await like(eventId, guests[0], guests[1])
    await like(eventId, guests[1], guests[0])

    expect(await connectionCounts(eventId)).toMatchObject({ connections: 1, connected: 2 })
  })

  it("counts only pairs of people who attended", async () => {
    // The denominator is attendees, so "met someone" cannot pass 100% or count
    // a ride share with somebody who never came.
    const { eventId, guests } = await room(MIN_ATTENDEES)
    const noshow = await makeUser("cm-noshow-ask")
    users.push(noshow)
    await ask(eventId, noshow, guests[0])

    expect(await connectionCounts(eventId)).toMatchObject({ connections: 0, connected: 0 })
  })

  it("returns counts only: hosts never see a pair or a person", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await wave(eventId, guests[0], guests[1])
    await wave(eventId, guests[1], guests[0])

    const leaves = (v: unknown): unknown[] => (v !== null && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v])
    for (const v of leaves(await eventInsights(eventId))) {
      if (typeof v === "string") expect(["few", "nearly_all", "not_recorded"]).toContain(v)
      else expect(typeof v === "number" || typeof v === "boolean" || v === null).toBe(true)
    }
  })
})

describe("how they met: each pair under the first way it met (the Live panel's split)", () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)

  it("splits pairs by way, and a pair met several ways counts once, under the earliest", async () => {
    const { eventId, guests } = await room(10)
    // Waved first, then shared a ride: a wave pair. Mutual at the second wave (20 min ago).
    await wave(eventId, guests[0], guests[1], minutesAgo(40))
    await wave(eventId, guests[1], guests[0], minutesAgo(20))
    await ask(eventId, guests[1], guests[0], "accepted", minutesAgo(10))
    // Shared a ride before the waves became mutual: a Lobby pair, though they also waved.
    await wave(eventId, guests[2], guests[3], minutesAgo(50))
    await ask(eventId, guests[3], guests[2], "accepted", minutesAgo(30))
    await wave(eventId, guests[3], guests[2], minutesAgo(5))
    // A request only.
    await request(guests[4], guests[5], eventId, "accepted", minutesAgo(15))
    // The controls: a wave nobody returned, a pending ask, a request from no room.
    await wave(eventId, guests[6], guests[7])
    await ask(eventId, guests[8], guests[9], "pending")
    await request(guests[7], guests[8], null)

    const counts = await connectionCounts(eventId)
    expect(counts.connections).toBe(3)
    expect(counts.byWay).toEqual({ waves: 1, lobby: 1, requests: 1 })
  })

  it("counts an old like answered either way as a wave pair", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    await like(eventId, guests[0], guests[1])
    await wave(eventId, guests[1], guests[0])
    await like(eventId, guests[2], guests[3])
    await like(eventId, guests[3], guests[2])
    expect((await connectionCounts(eventId)).byWay).toEqual({ waves: 2, lobby: 0, requests: 0 })
  })

  it("adds up to the connections, and leaves out pairs with somebody who never came", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    const noshow = await makeUser("cm-way-noshow")
    users.push(noshow)
    await ask(eventId, noshow, guests[0])
    await request(guests[1], guests[2], eventId)
    const counts = await connectionCounts(eventId)
    expect(counts.byWay.waves + counts.byWay.lobby + counts.byWay.requests).toBe(counts.connections)
    expect(counts.byWay).toEqual({ waves: 0, lobby: 0, requests: 1 })
  })
})

describe("reached out: the share who sent at least one wave, ask or request (approval 2)", () => {
  it("counts each kind of first move, and each person once across kinds", async () => {
    const { eventId, guests } = await room(10)
    const { eventId: elsewhere } = await room(0)
    await wave(eventId, guests[0], guests[9]) // nobody waved back: still a move by guests[0]
    await like(eventId, guests[1], guests[9]) // an old like is a hidden wave
    await ask(eventId, guests[2], guests[9], "declined")
    await request(guests[3], guests[9], eventId, "pending")
    // One person, every kind: one person.
    await wave(eventId, guests[4], guests[8])
    await ask(eventId, guests[4], guests[8], "pending")
    await request(guests[4], guests[7], eventId, "pending")
    // The controls: a request from another room is not a move here.
    await request(guests[5], guests[6], elsewhere, "pending")

    // 5 of 10 (guests 0-4), and the 5 who did not reach the floor too.
    expect(await funnelOf(eventId)).toMatchObject({ reachedOut: { pct: 50 } })
  })

  it("holds the share back when fewer than 5 reached out", async () => {
    const { eventId, guests } = await room(10)
    for (const g of guests.slice(0, 4)) await wave(eventId, g, guests[9])
    expect(await funnelOf(eventId)).toMatchObject({ held: false, reachedOut: null })
  })

  it("holds the share back when fewer than 5 did not (the complement)", async () => {
    // "6 of 10" names the 4 who sat it out to anyone who saw the room.
    const { eventId, guests } = await room(10)
    for (const g of guests.slice(0, 6)) await wave(eventId, g, guests[9])
    expect(await funnelOf(eventId)).toMatchObject({ held: false, reachedOut: null })
  })

  it("does not count a move by somebody who never checked in", async () => {
    const { eventId, guests } = await room(10)
    for (const g of guests.slice(0, 5)) await wave(eventId, g, guests[9])
    const noshow = await makeUser("cm-noshow-move")
    users.push(noshow)
    await ask(eventId, noshow, guests[9], "pending")
    // Counted, it would be 6 of 10, and the complement would hold it back.
    expect(await funnelOf(eventId)).toMatchObject({ reachedOut: { pct: 50 } })
  })

  it("is held back with everything else in a room under the pairs floor", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES - 1)
    for (const g of guests.slice(0, 5)) await wave(eventId, g, guests[6])
    expect(await funnelOf(eventId)).not.toHaveProperty("reachedOut.pct")
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

    expect(await connectionCounts(eventId)).toMatchObject({ attendees: 10, connections: 2, connected: 4 })
    // Two pairs, both by one way: the way is a few, so the total is a floor and
    // the per-person figure, which would give it back, is not shown (the
    // arithmetic, 2 x pairs / attendees, is pinned in event-insights.test.ts).
    expect(await funnelOf(eventId)).toMatchObject({ met: { count: 4, pct: 40 }, connections: { atLeast: 1 }, perAttendee: null })
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

    expect(await connectionCounts(eventId)).toMatchObject({ attendees: 10, connections: 3, connected: 4 })
  })

  it("reports a real zero for a room where nobody connected", async () => {
    // Distinct from suppression: this is a finding, not a withheld number.
    const { eventId } = await room(MIN_ATTENDEES)
    expect(await funnelOf(eventId)).toMatchObject({ held: false, connections: 0, met: { count: 0, pct: 0 }, perAttendee: 0 })
  })
})

describe("small rooms are suppressed", () => {
  it("withholds everything derived below the floor", async () => {
    // "One connection among three attendees" names both of them.
    const { eventId, guests } = await room(MIN_ATTENDEES - 1)
    await like(eventId, guests[0], guests[1])
    await like(eventId, guests[1], guests[0])

    expect(await funnelOf(eventId)).toEqual({ held: true, floor: MIN_ATTENDEES })
  })

  it("still reports how many attended", async () => {
    // Attendance is already on the page; withholding it here would be theatre.
    const { eventId } = await room(3)
    expect(await eventInsights(eventId)).toMatchObject({ attendees: 3, funnel: { held: true } })
  })

  it("reports at exactly the floor", async () => {
    const { eventId } = await room(MIN_ATTENDEES)
    expect(await funnelOf(eventId)).toMatchObject({ held: false })
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

    expect((await connectionCounts(eventId)).attendees).toBe(MIN_ATTENDEES)
  })
})

describe("kept talking: people in a connection whose chat from this room has a message from each side (Post A)", () => {
  /** A chat opened from this room (or from `origin`), with a message from each of `senders`. */
  async function chat(a: string, b: string, senders: string[], origin: { origin_event_id: string } | { origin_board_request_id: string } | null) {
    const c = await db.private_conversations.create({ data: { user1_id: a, user2_id: b, ...(origin ?? {}) } })
    for (const s of senders) await db.private_messages.create({ data: { conversation_id: c.id, sender_id: s, message_text: "hi" } })
    return c.id
  }

  it("counts both people of a connection once each side wrote, and nobody whose chat is one-sided", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES + 2)
    // Waved, both wrote: kept talking.
    await wave(eventId, guests[0], guests[1])
    await wave(eventId, guests[1], guests[0])
    await chat(guests[0], guests[1], [guests[0], guests[1], guests[0]], { origin_event_id: eventId })
    // Request accepted, only one wrote: met, did not keep talking (the control).
    await request(guests[2], guests[3], eventId)
    await chat(guests[2], guests[3], [guests[2], guests[2]], { origin_event_id: eventId })
    // A Lobby ask, its chat opened from the ask, both wrote: kept talking.
    await ask(eventId, guests[4], guests[5])
    const askId = (await db.board_requests.findFirstOrThrow({ where: { event_id: eventId, from_user_id: guests[4] } })).id
    await chat(guests[5], guests[4], [guests[4], guests[5]], { origin_board_request_id: askId })

    const counts = await connectionCounts(eventId)
    expect(counts.connections).toBe(3)
    expect(counts.keptTalking).toBe(4)
  })

  it("does not count a chat between people who never connected, or one opened somewhere else", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    // A chat from this room between two people who are not a connection here.
    await chat(guests[0], guests[1], [guests[0], guests[1]], { origin_event_id: eventId })
    // A connection whose chat was opened at another event.
    await wave(eventId, guests[2], guests[3])
    await wave(eventId, guests[3], guests[2])
    await chat(guests[2], guests[3], [guests[2], guests[3]], null)
    expect((await connectionCounts(eventId)).keptTalking).toBe(0)
  })

  it("counts a person once across several kept-talking connections", async () => {
    const { eventId, guests } = await room(MIN_ATTENDEES)
    for (const other of [guests[1], guests[2]]) {
      await wave(eventId, guests[0], other)
      await wave(eventId, other, guests[0])
      await chat(guests[0], other, [guests[0], other], { origin_event_id: eventId })
    }
    expect((await connectionCounts(eventId)).keptTalking).toBe(3)
  })
})
