import { likeAtEvent, matchesForEvent } from "@/lib/matches"
import { mayConverse } from "@/lib/conversations"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

/**
 * The match surface, against a real database.
 *
 * The unit tests cover the ranking judgment. These cover the things only a real
 * database can get wrong: who is eligible to appear at all, whether a block
 * actually hides someone, and whether a mutual like opens exactly one
 * conversation.
 */

const users: string[] = []
const events: string[] = []

async function attend(
  userId: string,
  eventId: string,
  opts: { kind?: "attendee" | "staff"; status?: "checked_in" | "checked_out" } = {}
) {
  await db.event_check_ins.create({
    data: {
      user_id: userId,
      event_id: eventId,
      occurrence_id: await occurrenceOf(eventId),
      check_in_time: new Date(),
      status: opts.status ?? "checked_in",
      kind: opts.kind ?? "attendee",
    },
  })
}

async function interest(userId: string, categoryId: string) {
  await db.user_interests.create({ data: { user_id: userId, category_id: categoryId } })
}

/*
 * Tracked, because nothing else deletes these.
 *
 * `cleanup(users, events)` takes users and events; categories were created and
 * left behind by every run. CI never notices — each job gets a fresh database —
 * but a local Postgres reused across a day accumulates them, and 58 rows named
 * "Techno" is what the admin taxonomy screen was rendering when it was opened
 * to be redesigned. A fixture that only tidies up in the environment where
 * tidiness does not matter is not tidying up.
 */
const categories: string[] = []

async function makeCategory(name: string) {
  const c = await db.categories.create({
    data: { name, slug: `${name}-${Math.random().toString(36).slice(2, 8)}` },
  })
  categories.push(c.id)
  return c.id
}

async function room() {
  const host = await makeUser("mx-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })
  return eventId
}

afterAll(async () => {
  await cleanup(users, events)
  // Interests first: `user_interests.category` is `onDelete: Cascade`, but the
  // users are already gone by here, so this is belt and braces against a run
  // that failed part-way through.
  if (categories.length) {
    await db.user_interests.deleteMany({ where: { category_id: { in: categories } } })
    await db.categories.deleteMany({ where: { id: { in: categories } } })
  }
  await closeDb()
})

describe("who can see the list at all", () => {
  it("refuses someone who never checked in", async () => {
    // A view of a room you were in, not a directory anyone can browse.
    const eventId = await room()
    const outsider = await makeUser("mx-out")
    users.push(outsider)
    expect(await matchesForEvent(eventId, outsider)).toBeNull()
  })

  it("shows the room to someone who attended", async () => {
    const eventId = await room()
    const [me, them] = await Promise.all([makeUser("mx-a"), makeUser("mx-b")])
    users.push(me, them)
    await attend(me, eventId)
    await attend(them, eventId)

    const matches = await matchesForEvent(eventId, me)
    expect(matches!.map((m) => m.userId)).toEqual([them])
  })
})

describe("who appears in it", () => {
  it("leaves out staff", async () => {
    // Staff are working, not mingling — and it would be strange to offer the bar
    // manager as a match.
    const eventId = await room()
    const [me, crew] = await Promise.all([makeUser("mx-c"), makeUser("mx-crew")])
    users.push(me, crew)
    await attend(me, eventId)
    await attend(crew, eventId, { kind: "staff" })

    expect(await matchesForEvent(eventId, me)).toEqual([])
  })

  it("keeps people who have already left", async () => {
    // They were in the room with you. Ranking puts them lower; hiding them would
    // empty the screen an hour after doors.
    const eventId = await room()
    const [me, gone] = await Promise.all([makeUser("mx-d"), makeUser("mx-gone")])
    users.push(me, gone)
    await attend(me, eventId)
    await attend(gone, eventId, { status: "checked_out" })

    const matches = await matchesForEvent(eventId, me)
    expect(matches!.map((m) => m.userId)).toEqual([gone])
    expect(matches![0].insideNow).toBe(false)
  })

  it("hides people blocked in either direction", async () => {
    const eventId = await room()
    const [me, blocked, blocker] = await Promise.all([
      makeUser("mx-e"),
      makeUser("mx-blocked"),
      makeUser("mx-blocker"),
    ])
    users.push(me, blocked, blocker)
    for (const u of [me, blocked, blocker]) await attend(u, eventId)

    await db.blocked_users.create({ data: { blocker_id: me, blocked_id: blocked } })
    await db.blocked_users.create({ data: { blocker_id: blocker, blocked_id: me } })

    expect(await matchesForEvent(eventId, me)).toEqual([])
  })
})

describe("the card", () => {
  it("names the shared interests rather than their ids", async () => {
    // A uuid explains nothing to the person reading it.
    const eventId = await room()
    const [me, them] = await Promise.all([makeUser("mx-f"), makeUser("mx-g")])
    users.push(me, them)
    await attend(me, eventId)
    await attend(them, eventId)

    const techno = await makeCategory("Techno")
    await interest(me, techno)
    await interest(them, techno)

    const matches = await matchesForEvent(eventId, me)
    expect(matches![0].sharedInterests).toEqual(["Techno"])
  })

  it("shows the room pseudonym, not the real name", async () => {
    const eventId = await room()
    const [me, them] = await Promise.all([makeUser("mx-h"), makeUser("mx-i")])
    users.push(me, them)
    await attend(me, eventId)
    await attend(them, eventId)

    const group = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId } })
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: them, anonymous_name: "Cosmic Panda" },
    })

    const matches = await matchesForEvent(eventId, me)
    expect(matches![0].displayName).toBe("Cosmic Panda")
    expect(JSON.stringify(matches)).not.toContain("Test mx-i")
  })

  it("never says whether they liked you", async () => {
    // The one thing that would turn this into a different product.
    const eventId = await room()
    const [me, them] = await Promise.all([makeUser("mx-j"), makeUser("mx-k")])
    users.push(me, them)
    await attend(me, eventId)
    await attend(them, eventId)

    await likeAtEvent(eventId, them, me)

    const matches = await matchesForEvent(eventId, me)
    expect(matches![0].youLiked).toBe(false)
    expect(Object.keys(matches![0])).not.toContain("theyLikedYou")
    expect(JSON.stringify(matches)).not.toMatch(/likedYou|likesYou/i)
  })
})

describe("likes", () => {
  it("is not mutual on its own", async () => {
    const eventId = await room()
    const [me, them] = await Promise.all([makeUser("mx-l"), makeUser("mx-m")])
    users.push(me, them)

    expect(await likeAtEvent(eventId, me, them)).toEqual({ mutual: false })
  })

  it("liking twice is the same as liking once", async () => {
    const eventId = await room()
    const [me, them] = await Promise.all([makeUser("mx-n"), makeUser("mx-o")])
    users.push(me, them)

    await likeAtEvent(eventId, me, them)
    await likeAtEvent(eventId, me, them)
    expect(await db.event_likes.count({ where: { event_id: eventId, liker_id: me } })).toBe(1)
  })

  it("opens exactly one conversation when it becomes mutual", async () => {
    const eventId = await room()
    const [me, them] = await Promise.all([makeUser("mx-p"), makeUser("mx-q")])
    users.push(me, them)

    await likeAtEvent(eventId, me, them)
    const back = await likeAtEvent(eventId, them, me)

    expect(back.mutual).toBe(true)
    expect(back.conversationId).toBeDefined()
    // Both orderings resolve to the same row — the pair is sorted in one place.
    const count = await db.private_conversations.count({
      where: { OR: [{ user1_id: me }, { user2_id: me }] },
    })
    expect(count).toBe(1)
  })

  it("makes the pair able to converse, through the same gate as a request", async () => {
    // A mutual like is two people agreeing to talk, which is what a message
    // request establishes. `mayConverse` accepts it for that reason rather than
    // through a special case.
    const eventId = await room()
    const [me, them] = await Promise.all([makeUser("mx-r"), makeUser("mx-s")])
    users.push(me, them)

    expect(await mayConverse(me, them)).toBe(false)
    await likeAtEvent(eventId, me, them)
    await likeAtEvent(eventId, them, me)
    expect(await mayConverse(me, them)).toBe(true)
  })

  it("is scoped to the event", async () => {
    // A like is about a person in a particular room on a particular night.
    // Carrying it across events would make a room into a follower graph.
    const [eventA, eventB] = await Promise.all([room(), room()])
    const [me, them] = await Promise.all([makeUser("mx-t"), makeUser("mx-u")])
    users.push(me, them)

    await likeAtEvent(eventA, me, them)
    expect(await likeAtEvent(eventB, them, me)).toEqual({ mutual: false })
  })
})
