import {
  blockedEitherWay,
  conversationPair,
  haveSharedAnEvent,
  mayConverse,
  openConversation,
} from "@/lib/conversations"

import { VISIBLE_DM } from "@/lib/dm-moderation"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

/**
 * The gate between "in the same room" and "talking privately".
 *
 * DMs are meant to be gated behind a message request the other person accepted —
 * that is the guarantee the pseudonymous room rests on. Four separate defects
 * meant it was not:
 *
 *   - `POST /conversations` created a conversation from two user ids alone, so
 *     the gate existed only on the screen that happened to use it
 *   - responding "block" set a status and wrote no `blocked_users` row
 *   - the DM send path checked one direction of the block
 *   - the two conversation-creation paths ordered the pair differently, so
 *     `@@unique([user1_id, user2_id])` could be evaded
 *
 * All four are database-shaped, which is why these are integration tests: the
 * unit suite mocks `lib/db` and cannot tell a working query from one that throws.
 */

const users: string[] = []
const events: string[] = []

async function attend(userId: string, eventId: string) {
  await db.event_check_ins.create({
    data: {
      user_id: userId,
      event_id: eventId,
      occurrence_id: await occurrenceOf(eventId),
      check_in_time: new Date(),
      status: "checked_in",
    },
  })
}

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("the pair is stored in one canonical order", () => {
  it("sorts regardless of who asked", () => {
    // The whole reason `@@unique([user1_id, user2_id])` means anything. Stored
    // both ways, one pair of people gets two conversation rows and the
    // constraint cannot see it.
    expect(conversationPair("b", "a")).toEqual(["a", "b"])
    expect(conversationPair("a", "b")).toEqual(["a", "b"])
  })

  it("opening from either side returns the same row", async () => {
    const [alice, bob] = await Promise.all([makeUser("dm-a"), makeUser("dm-b")])
    users.push(alice, bob)

    const first = await openConversation(alice, bob)
    const second = await openConversation(bob, alice)

    expect(second.id).toBe(first.id)
    const count = await db.private_conversations.count({
      where: { OR: [{ user1_id: alice }, { user2_id: alice }] },
    })
    expect(count).toBe(1)
  })
})

describe("co-presence is required to ask", () => {
  it("is false for two people who never shared an event", async () => {
    const [a, b] = await Promise.all([makeUser("cp-a"), makeUser("cp-b")])
    users.push(a, b)
    expect(await haveSharedAnEvent(a, b)).toBe(false)
  })

  it("is true once both checked in to the same event", async () => {
    const [a, b, host] = await Promise.all([
      makeUser("cp-c"),
      makeUser("cp-d"),
      makeUser("cp-host", "organizer"),
    ])
    users.push(a, b, host)
    const eventId = await makeEvent(host)
    events.push(eventId)

    await attend(a, eventId)
    await attend(b, eventId)

    expect(await haveSharedAnEvent(a, b)).toBe(true)
    // Symmetric — "we were in a room together" is not directional.
    expect(await haveSharedAnEvent(b, a)).toBe(true)
  })

  it("stays true after they leave", async () => {
    // The ordinary use of this feature is messaging the next morning. The room
    // is where the right is earned; it does not expire on the way out.
    const [a, b, host] = await Promise.all([
      makeUser("cp-e"),
      makeUser("cp-f"),
      makeUser("cp-host2", "organizer"),
    ])
    users.push(a, b, host)
    const eventId = await makeEvent(host)
    events.push(eventId)

    await attend(a, eventId)
    await attend(b, eventId)
    await db.event_check_ins.updateMany({
      where: { event_id: eventId },
      data: { status: "checked_out", check_out_time: new Date() },
    })

    expect(await haveSharedAnEvent(a, b)).toBe(true)
  })

  it("an RSVP is not attendance", async () => {
    // Someone who said they were coming was never in the room with anyone.
    const [a, b, host] = await Promise.all([
      makeUser("cp-g"),
      makeUser("cp-h"),
      makeUser("cp-host3", "organizer"),
    ])
    users.push(a, b, host)
    const eventId = await makeEvent(host)
    events.push(eventId)

    await attend(a, eventId)
    await db.event_check_ins.create({
      data: {
        user_id: b,
        event_id: eventId,
        occurrence_id: await occurrenceOf(eventId),
        check_in_time: null,
        status: "checked_out",
      },
    })

    expect(await haveSharedAnEvent(a, b)).toBe(false)
  })
})

describe("blocks run both ways", () => {
  it("is true whichever side blocked", async () => {
    const [a, b] = await Promise.all([makeUser("bl-a"), makeUser("bl-b")])
    users.push(a, b)

    expect(await blockedEitherWay(a, b)).toBe(false)
    await db.blocked_users.create({ data: { blocker_id: a, blocked_id: b } })

    // The defect: only the first of these was ever checked on the send path, so
    // the person who blocked could still message the person they blocked.
    expect(await blockedEitherWay(b, a)).toBe(true)
    expect(await blockedEitherWay(a, b)).toBe(true)
  })
})

describe("a conversation needs an accepted request", () => {
  it("refuses two strangers", async () => {
    const [a, b] = await Promise.all([makeUser("mc-a"), makeUser("mc-b")])
    users.push(a, b)
    expect(await mayConverse(a, b)).toBe(false)
  })

  it("allows it once the request is accepted", async () => {
    const [a, b] = await Promise.all([makeUser("mc-c"), makeUser("mc-d")])
    users.push(a, b)

    await db.message_requests.create({
      data: { sender_id: a, recipient_id: b, status: "accepted", responded_at: new Date() },
    })
    expect(await mayConverse(a, b)).toBe(true)
    expect(await mayConverse(b, a)).toBe(true)
  })

  it("does not count a request still pending or declined", async () => {
    const [a, b, c] = await Promise.all([
      makeUser("mc-e"),
      makeUser("mc-f"),
      makeUser("mc-g"),
    ])
    users.push(a, b, c)

    await db.message_requests.create({
      data: { sender_id: a, recipient_id: b, status: "pending" },
    })
    await db.message_requests.create({
      data: { sender_id: a, recipient_id: c, status: "declined", responded_at: new Date() },
    })

    expect(await mayConverse(a, b)).toBe(false)
    expect(await mayConverse(a, c)).toBe(false)
  })

  it("keeps existing conversations working", async () => {
    // Pairs who connected before this check existed must not be cut off.
    const [a, b] = await Promise.all([makeUser("mc-h"), makeUser("mc-i")])
    users.push(a, b)

    await openConversation(a, b)
    expect(await mayConverse(a, b)).toBe(true)
  })
})

describe("a hidden message is invisible to every reader", () => {
  async function thread() {
    const a = await makeUser("dm_vis_a")
    const b = await makeUser("dm_vis_b")
    users.push(a, b)
    const conversation = await openConversation(a, b)
    const say = (sender: string, message_text: string, moderation_status: string | null) =>
      db.private_messages.create({
        data: {
          conversation_id: conversation.id,
          sender_id: sender,
          message_text,
          moderation_status,
        },
        select: { id: true },
      })
    return { a, b, conversation, say }
  }

  it("keeps an ordinary message, which has no verdict at all", async () => {
    /*
     * THE assertion on this predicate, and the reason it is written as an
     * explicit OR rather than `{ not: "hidden" }`.
     *
     * In SQL `moderation_status <> 'hidden'` is NULL for a NULL row and
     * therefore false, and NULL is the ordinary case — almost every message has
     * no verdict, because DMs get the deterministic checks and no model, so
     * nothing is ever recorded as `clean`. A `not` that did not expand to
     * include NULL would hide **the entire message history of every
     * conversation in the product**, and it would do it silently.
     *
     * Against real Postgres, because that is the only place the difference
     * exists: `geofence-clear.itest.ts` is the precedent, where a nullability
     * distinction read correctly through the client and was false in the
     * database.
     */
    const { a, conversation, say } = await thread()
    await say(a, "ordinary", null)

    const visible = await db.private_messages.findMany({
      where: { conversation_id: conversation.id, ...VISIBLE_DM },
      select: { message_text: true },
    })
    expect(visible.map((m) => m.message_text)).toEqual(["ordinary"])
  })

  it("keeps a flagged message, because flagging never hides", async () => {
    /*
     * Contact details are flagged and delivered. Refusing would teach the
     * sender exactly where the boundary is and the next attempt would be
     * spelled out with nothing behind it — the group path's argument, and it
     * applies here more strongly, since a DM is where moving off-platform
     * actually lands.
     */
    const { a, conversation, say } = await thread()
    await say(a, "reach me on 9876543210", "flagged")

    const visible = await db.private_messages.findMany({
      where: { conversation_id: conversation.id, ...VISIBLE_DM },
      select: { message_text: true },
    })
    expect(visible).toHaveLength(1)
  })

  it("drops a hidden one, from the thread and from the unread count", async () => {
    /*
     * The unread count is the reader that gets forgotten. A hidden message is
     * never delivered, so it is never marked read — leaving it in the count is
     * a badge nobody can clear, on a thread with nothing in it to clear.
     */
    const { a, b, conversation, say } = await thread()
    await say(a, "ordinary", null)
    await say(a, "slur", "hidden")

    const visible = await db.private_messages.findMany({
      where: { conversation_id: conversation.id, ...VISIBLE_DM },
      select: { message_text: true },
    })
    expect(visible.map((m) => m.message_text)).toEqual(["ordinary"])

    const unread = await db.private_messages.count({
      where: {
        conversation_id: conversation.id,
        is_read: false,
        sender_id: { not: b },
        ...VISIBLE_DM,
      },
    })
    expect(unread).toBe(1)
  })

  it("still stores it, because a report has nothing else to rest on", async () => {
    /*
     * `moderation_flags.message_id` is a NOT NULL foreign key to
     * `chat_messages`, so a flag against a DM is structurally impossible and
     * the row itself is the only record. Hiding must not mean deleting.
     */
    const { a, conversation, say } = await thread()
    await say(a, "slur", "hidden")

    const all = await db.private_messages.count({
      where: { conversation_id: conversation.id },
    })
    expect(all).toBe(1)
  })
})
