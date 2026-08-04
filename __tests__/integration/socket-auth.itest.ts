import { canJoinChat, canJoinConversation, canJoinEvent } from "@/lib/socket-auth"
import { db, cleanup, closeDb, makeUser, makeEvent, testId } from "./helpers"

/**
 * The unit version of these tests mocks `@/lib/db` and asserts on the mock's
 * arguments. That proves the predicate asks the right question — not that
 * Postgres answers it the way we expect.
 *
 * These run the same predicates against real SQL, so a Prisma upgrade that
 * changes compound-key lookups, `deleted_at` filtering, or `in` semantics
 * fails here instead of in production.
 */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("canJoinChat against a real database", () => {
  it("denies a non-member and allows a member", async () => {
    const owner = await makeUser("owner", "organizer")
    const member = await makeUser("member")
    const stranger = await makeUser("stranger")
    users.push(owner, member, stranger)
    const eventId = await makeEvent(owner)
    events.push(eventId)

    const group = await db.chat_groups.create({
      data: { event_id: eventId, name: "itest chat", status: "active" },
    })
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: member, status: "active" },
    })

    await expect(canJoinChat(member, group.id)).resolves.toBe(true)
    await expect(canJoinChat(stranger, group.id)).resolves.toBe(false)
  })

  it("denies a banned member but allows a muted one", async () => {
    const owner = await makeUser("owner2", "organizer")
    const banned = await makeUser("banned")
    const muted = await makeUser("muted")
    users.push(owner, banned, muted)
    const eventId = await makeEvent(owner)
    events.push(eventId)

    const group = await db.chat_groups.create({
      data: { event_id: eventId, name: "itest chat 2", status: "active" },
    })
    await db.chat_group_members.createMany({
      data: [
        { chat_group_id: group.id, user_id: banned, status: "banned" },
        { chat_group_id: group.id, user_id: muted, status: "muted" },
      ],
    })

    await expect(canJoinChat(banned, group.id)).resolves.toBe(false)
    await expect(canJoinChat(muted, group.id)).resolves.toBe(true)
  })

  it("rejects a malformed room id instead of returning a result", async () => {
    // chat_group_id is @db.Uuid. guardJoin depends on this REJECTING so it can
    // fail closed — if Prisma ever starts returning null here instead, the
    // fail-closed path silently becomes a fail-open one.
    await expect(canJoinChat("someone", "not-a-uuid")).rejects.toThrow()
  })
})

describe("canJoinConversation against a real database", () => {
  it("allows both participants and denies a third party", async () => {
    const a = await makeUser("convo_a")
    const b = await makeUser("convo_b")
    const c = await makeUser("convo_c")
    users.push(a, b, c)

    const convo = await db.private_conversations.create({
      data: { user1_id: a, user2_id: b },
    })

    await expect(canJoinConversation(a, convo.id)).resolves.toBe(true)
    await expect(canJoinConversation(b, convo.id)).resolves.toBe(true)
    await expect(canJoinConversation(c, convo.id)).resolves.toBe(false)
  })
})

describe("canJoinEvent against a real database", () => {
  it("opens public events to anyone and gates private ones", async () => {
    const owner = await makeUser("evt_owner", "organizer")
    const stranger = await makeUser("evt_stranger")
    users.push(owner, stranger)

    const pub = await makeEvent(owner, { visibility: "public" })
    const priv = await makeEvent(owner, { visibility: "private" })
    events.push(pub, priv)

    await expect(canJoinEvent(stranger, pub)).resolves.toBe(true)
    await expect(canJoinEvent(stranger, priv)).resolves.toBe(false)
    await expect(canJoinEvent(owner, priv)).resolves.toBe(true)
  })

  it("treats going/maybe as access but not_going as denial", async () => {
    const owner = await makeUser("rsvp_owner", "organizer")
    const going = await makeUser("rsvp_going")
    const maybe = await makeUser("rsvp_maybe")
    const declined = await makeUser("rsvp_no")
    users.push(owner, going, maybe, declined)

    const priv = await makeEvent(owner, { visibility: "private" })
    events.push(priv)

    await db.event_rsvps.createMany({
      data: [
        { event_id: priv, user_id: going, status: "going" },
        { event_id: priv, user_id: maybe, status: "maybe" },
        { event_id: priv, user_id: declined, status: "not_going" },
      ],
    })

    await expect(canJoinEvent(going, priv)).resolves.toBe(true)
    await expect(canJoinEvent(maybe, priv)).resolves.toBe(true)
    // The bug Codex found: any RSVP row used to grant access, so declining an
    // invite still handed out a live attendance feed.
    await expect(canJoinEvent(declined, priv)).resolves.toBe(false)
  })

  it("excludes soft-deleted events", async () => {
    const owner = await makeUser("del_owner", "organizer")
    users.push(owner)
    const deleted = await makeEvent(owner, { visibility: "public", deleted_at: new Date() })
    events.push(deleted)

    await expect(canJoinEvent(owner, deleted)).resolves.toBe(false)
  })
})

describe("schema assumptions the app depends on", () => {
  it("enforces one membership row per (chat_group, user)", async () => {
    const owner = await makeUser("uniq_owner", "organizer")
    const member = await makeUser("uniq_member")
    users.push(owner, member)
    const eventId = await makeEvent(owner)
    events.push(eventId)

    const group = await db.chat_groups.create({
      data: { event_id: eventId, name: "itest uniq", status: "active" },
    })
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: member, status: "active" },
    })

    // canJoinChat uses findUnique on the compound key, which requires this.
    await expect(
      db.chat_group_members.create({
        data: { chat_group_id: group.id, user_id: member, status: "active" },
      })
    ).rejects.toThrow()
  })

  it("cascades chat messages when an event is deleted", async () => {
    const owner = await makeUser("cascade_owner", "organizer")
    users.push(owner)
    const eventId = await makeEvent(owner)

    const group = await db.chat_groups.create({
      data: { event_id: eventId, name: "itest cascade", status: "active" },
    })
    await db.chat_messages.create({
      data: { chat_group_id: group.id, user_id: owner, content: "hi", type: "text" },
    })

    await db.events.delete({ where: { id: eventId } })

    const orphans = await db.chat_messages.count({ where: { chat_group_id: group.id } })
    expect(orphans).toBe(0)
  })
})

describe("capacity guard", () => {
  it("refuses to increment past max_capacity in one atomic statement", async () => {
    // The check-in route relies on this conditional UPDATE to prevent
    // overbooking under concurrency. If Prisma changes $executeRaw semantics,
    // events silently overbook.
    const owner = await makeUser("cap_owner", "organizer")
    users.push(owner)
    const slug = testId("cap")
    const now = Date.now()
    const ev = await db.events.create({
      data: {
        slug,
        title: "capacity fixture",
        description: "x",
        start_time: new Date(now - 1000),
        end_time: new Date(now + 60_000),
        timezone: "UTC",
        status: "published",
        organizer_id: owner,
        max_capacity: 1,
        current_capacity: 1,
      },
    })
    events.push(ev.id)

    const updated = await db.$executeRaw`
      UPDATE events SET current_capacity = current_capacity + 1
      WHERE id = ${ev.id}::uuid AND current_capacity < max_capacity`

    expect(updated).toBe(0)
    const after = await db.events.findUnique({ where: { id: ev.id } })
    expect(after!.current_capacity).toBe(1)
  })
})
