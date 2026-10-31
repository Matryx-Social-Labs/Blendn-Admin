import { maySeeIdentity } from "@/lib/identity"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

/**
 * Who may put a name to a pseudonym.
 *
 * The room is pseudonymous and every room surface hands out the real user id,
 * because the client needs it to block, report and open a message request. That
 * was safe only if the id could not be exchanged for an identity, and it could:
 * `GET /users/:id` took any valid token. Two requests de-anonymised a room.
 *
 * These pin the four ways in and, more importantly, the ways that are not.
 */

const users: string[] = []
const events: string[] = []

async function guest(label: string) {
  const id = await makeUser(label)
  users.push(id)
  return id
}

async function anEvent() {
  const host = await makeUser(`ig-host-${Math.random().toString(36).slice(2, 7)}`, "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  return eventId
}

const like = (eventId: string, a: string, b: string) =>
  db.event_likes.create({ data: { event_id: eventId, liker_id: a, liked_id: b } })

/**
 * Check in, and record what they chose for this event.
 *
 * Two writes because they are two things now: attendance is per occurrence and
 * the choice is per event. `revealed` used to sit on the check-in row, where a
 * multi-day event gave one person several of them and the reader picked one at
 * random — see `event_match_preferences`. This mirrors what the check-in route
 * does, so the gate is exercised against the shape production actually stores.
 */
async function checkIn(eventId: string, userId: string, revealed = false) {
  await db.event_check_ins.create({
    data: {
      event_id: eventId,
      occurrence_id: await occurrenceOf(eventId),
      user_id: userId,
      status: "checked_in",
      check_in_time: new Date(),
    },
  })
  await db.event_match_preferences.upsert({
    where: { event_id_user_id: { event_id: eventId, user_id: userId } },
    create: { event_id: eventId, user_id: userId, revealed },
    update: { revealed },
  })
}

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("identity is not visible by default", () => {
  it("not to a stranger", async () => {
    const [me, them] = await Promise.all([guest("ig-a"), guest("ig-b")])
    expect(await maySeeIdentity(me, them)).toBe(false)
  })

  it("not to someone who merely shared a room", async () => {
    // Co-presence is what lets you send a request. It is not consent to be
    // identified -- which is the whole reason the pseudonym exists.
    const eventId = await anEvent()
    const [me, them] = await Promise.all([guest("ig-c"), guest("ig-d")])
    await checkIn(eventId, me)
    await checkIn(eventId, them)

    expect(await maySeeIdentity(me, them)).toBe(false)
  })

  it("not to someone who liked you without it being returned", async () => {
    // Otherwise liking everyone in the room is a de-anonymisation button.
    const eventId = await anEvent()
    const [me, them] = await Promise.all([guest("ig-e"), guest("ig-f")])
    await like(eventId, me, them)

    expect(await maySeeIdentity(me, them)).toBe(false)
  })

  it("not when the two likes are at different events", async () => {
    // A mutual like means "we both chose this, here". Crossing events would
    // let two one-sided likes in different rooms add up to a match.
    const [first, second] = await Promise.all([anEvent(), anEvent()])
    const [me, them] = await Promise.all([guest("ig-g"), guest("ig-h")])
    await like(first, me, them)
    await like(second, them, me)

    expect(await maySeeIdentity(me, them)).toBe(false)
  })
})

describe("identity is visible once someone has opted in", () => {
  it("to yourself", async () => {
    const me = await guest("ig-i")
    expect(await maySeeIdentity(me, me)).toBe(true)
  })

  it("not on a mutual like alone: the conversation it opens decides (SCRUM-752)", async () => {
    const eventId = await anEvent()
    const [me, them] = await Promise.all([guest("ig-j"), guest("ig-k")])
    await like(eventId, me, them)
    await like(eventId, them, me)

    expect(await maySeeIdentity(me, them)).toBe(false)
    expect(await maySeeIdentity(them, me)).toBe(false)
  })

  it("once a conversation exists", async () => {
    const [me, them] = await Promise.all([guest("ig-l"), guest("ig-m")])
    const [a, b] = [me, them].sort()
    await db.private_conversations.create({ data: { user1_id: a, user2_id: b } })

    expect(await maySeeIdentity(me, them)).toBe(true)
    expect(await maySeeIdentity(them, me)).toBe(true)
  })

  it("when they chose to be public in a room you were in", async () => {
    const eventId = await anEvent()
    const [me, them] = await Promise.all([guest("ig-n"), guest("ig-o")])
    await checkIn(eventId, me)
    await checkIn(eventId, them, true)

    expect(await maySeeIdentity(me, them)).toBe(true)
    // One-way: they went public, you did not.
    expect(await maySeeIdentity(them, me)).toBe(false)
  })

  it("but not to someone who was not in that room", async () => {
    const eventId = await anEvent()
    const [them, outsider] = await Promise.all([guest("ig-p"), guest("ig-q")])
    await checkIn(eventId, them, true)

    expect(await maySeeIdentity(outsider, them)).toBe(false)
  })
})

/*
 * A message request names its sender to its recipient: the request list already shows them `sender.name` and
 * `sender.image` (docs/API.md, "the reveal is deliberate"), so the profile must agree, or the recipient sees a name in
 * the list and "Attendee" + Connect on the profile, with no Accept/Decline (SCRUM-975). One way only, while pending,
 * and a block still beats it.
 */
describe("a pending message request", () => {
  const ask = (sender: string, recipient: string, status: "pending" | "declined" = "pending") =>
    db.message_requests.create({ data: { sender_id: sender, recipient_id: recipient, message: "coffee?", status } })

  it("names the sender to the recipient", async () => {
    const [sender, recipient] = [await guest("ig-mr-s"), await guest("ig-mr-r")]
    await ask(sender, recipient)
    expect(await maySeeIdentity(recipient, sender)).toBe(true)
  })

  it("does not name the recipient to the sender", async () => {
    const [sender, recipient] = [await guest("ig-mr-s2"), await guest("ig-mr-r2")]
    await ask(sender, recipient)
    expect(await maySeeIdentity(sender, recipient)).toBe(false)
  })

  it("names nobody once declined", async () => {
    const [sender, recipient] = [await guest("ig-mr-s3"), await guest("ig-mr-r3")]
    await ask(sender, recipient, "declined")
    expect(await maySeeIdentity(recipient, sender)).toBe(false)
  })

  it("is beaten by a block either way", async () => {
    const [sender, recipient] = [await guest("ig-mr-s4"), await guest("ig-mr-r4")]
    await ask(sender, recipient)
    await db.blocked_users.create({ data: { blocker_id: recipient, blocked_id: sender } })
    expect(await maySeeIdentity(recipient, sender)).toBe(false)
  })
})
