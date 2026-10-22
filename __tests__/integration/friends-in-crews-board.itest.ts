import { roomHandle } from "@/lib/room-handle"
import { db } from "./helpers"
import { api, arrive, befriend, cleanupCrewWorld, crewOf, liveEvent, person, socketHarness, world, type Person } from "./crew-world"

/**
 * B3: crews, Blends, the board and ratings keep friends apart (the owner's rule,
 * 2026-10-22, plans/friends-in-room.md D18-D20). A friend across the two sides of
 * a crew is a stranger to the other inside a pseudonymous room, so it counts as a
 * block does: the crew is hidden, a like answers as one across a block, and a
 * Blend is never made (again under the Blend's lock). A friend's board post is
 * not on your board and an ask to it is the taken-down answer; two askers who are
 * friends are not seated together; friends are not rated as strangers.
 */

const sockets = socketHarness()
beforeAll(() => sockets.start())
afterAll(async () => {
  await sockets.stop()
  await db.chat_group_members.deleteMany({ where: { chat_group: { board_post: { event_id: { in: world.events } } } } })
  await db.chat_groups.deleteMany({ where: { board_post: { event_id: { in: world.events } } } })
  await db.board_requests.deleteMany({ where: { event_id: { in: world.events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: world.events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: world.events } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: world.users } } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: world.users } }, { user2_id: { in: world.users } }] } })
  await db.categories.deleteMany({ where: { name: { startsWith: "f" }, slug: { contains: "-" }, user_interests: { none: {} } } }).catch(() => undefined)
  await cleanupCrewWorld()
})

async function twoCrews(label: string) {
  const host = await person(`${label}-host`)
  const { eventId, occurrenceId } = await liveEvent(host.id)
  const [a1, a2, a3] = await Promise.all(["a1", "a2", "a3"].map((l) => person(`${label}-${l}`, `Ananya ${l} Bhat`)))
  const [b1, b2, b3] = await Promise.all(["b1", "b2", "b3"].map((l) => person(`${label}-${l}`, `Vikram ${l} Shetty`)))
  const A = await crewOf(a1, [a2, a3], "Crew Two")
  const B = await crewOf(b1, [b2, b3], "Crew Five")
  for (const p of [a1, a2, b1, b2]) await arrive(eventId, occurrenceId, p)
  return { eventId, occurrenceId, A, B, a: [a1, a2, a3], b: [b1, b2, b3] }
}

const crewIds = async (as: Person, eventId: string) =>
  ((await api.atEvent(as, eventId)).body.data.crews as { crewId: string }[]).map((c) => c.crewId)

describe("crews and Blends: a friendship across the two sides keeps them apart, like a block (D18)", () => {
  it("hides the crew from every member of the other side, and a like across it answers as one across a block, writing nothing", async () => {
    const w = await twoCrews("fc")
    // Control: nothing between them, the crew shows and a like stands.
    expect(await crewIds(w.a[0], w.eventId)).toContain(w.B.crewId)

    // One friendship between ANY member of one crew and any member of the other.
    await befriend(w.a[2], w.b[2])
    expect(await crewIds(w.a[0], w.eventId)).not.toContain(w.B.crewId)
    expect(await crewIds(w.b[0], w.eventId)).not.toContain(w.A.crewId)

    const blocked = await (async () => {
      await befriend(w.a[0], w.b[0])
      return null
    })()
    void blocked
    const crewLike = await api.likeCrew(w.a[1], w.eventId, w.B.crewId, w.A.crewId)
    // The comparator: a like across a real block.
    const w2 = await twoCrews("fcb")
    await db.blocked_users.create({ data: { blocker_id: w2.a[2].id, blocked_id: w2.b[2].id } })
    const acrossBlock = await api.likeCrew(w2.a[1], w2.eventId, w2.B.crewId, w2.A.crewId)
    expect({ status: crewLike.status, data: crewLike.body.data, error: crewLike.body.errorCode }).toEqual({
      status: acrossBlock.status,
      data: acrossBlock.body.data,
      error: acrossBlock.body.errorCode,
    })
    expect(await db.crew_likes.count({ where: { occurrence_id: w.occurrenceId } })).toBe(0)
  })

  it("a crew-to-person like across a friendship answers as one across a block, and writes nothing", async () => {
    const w = await twoCrews("fp")
    await befriend(w.a[0], w.b[0])
    const w2 = await twoCrews("fpb")
    await db.blocked_users.create({ data: { blocker_id: w2.a[0].id, blocked_id: w2.b[0].id } })
    const [viaFriend, viaBlock] = [
      await api.likePerson(w.a[1], w.eventId, roomHandle(w.eventId, w.b[1].id), w.A.crewId),
      await api.likePerson(w2.a[1], w2.eventId, roomHandle(w2.eventId, w2.b[1].id), w2.A.crewId),
    ]
    expect({ status: viaFriend.status, body: viaFriend.body }).toEqual({ status: viaBlock.status, body: viaBlock.body })
    expect(await db.crew_likes.count({ where: { occurrence_id: w.occurrenceId } })).toBe(0)
  })

  it("a friendship made between two mutual crew likes produces no Blend (the in-lock re-check)", async () => {
    const w = await twoCrews("fl")
    expect((await api.likeCrew(w.a[0], w.eventId, w.B.crewId, w.A.crewId)).body.data).toEqual({ liked: true, blend: null })
    await befriend(w.a[2], w.b[2])
    const back = await api.likeCrew(w.b[0], w.eventId, w.A.crewId, w.B.crewId)
    // The crew is hidden now: the like back is "no such crew", and no Blend.
    expect(back.body.errorCode).toBe("NOT_FOUND")
    expect(await db.blends.count({ where: { occurrence_id: w.occurrenceId } })).toBe(0)
  })

  it("and again under the Blend's lock: a friendship that lands while the second like waits for it still makes no Blend", async () => {
    const w = await twoCrews("fk")
    expect((await api.likeCrew(w.a[0], w.eventId, w.B.crewId, w.A.crewId)).body.data).toEqual({ liked: true, blend: null })
    const [lo, hi] = [w.A.crewId, w.B.crewId].sort()
    const key = `blend:${w.occurrenceId}:${lo}:${hi}`
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const taken = new Promise<void>((r) => (locked = r))
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
        locked()
        await held
      },
      { timeout: 20_000 }
    )
    await taken
    const pending = api.likeCrew(w.b[0], w.eventId, w.A.crewId, w.B.crewId)
    for (let i = 0; i < 100; i++) {
      const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
      if (Number(n) > 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await befriend(w.a[2], w.b[2])
    release()
    await holder
    const back = await pending
    expect(back.body.data?.blend ?? null).toBeNull()
    expect(await db.blends.count({ where: { occurrence_id: w.occurrenceId } })).toBe(0)
  })
})

describe("the board and ratings (D19, D20)", () => {
  async function boardRoom() {
    const host = await person("fb-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() + 24 * 3600_000), end_time: new Date(Date.now() + 27 * 3600_000) } })
    return { eventId, occurrenceId }
  }

  it("a friend's post is not on your board, and an ask to it is the taken-down answer", async () => {
    const { eventId } = await boardRoom()
    const [viewer, friend, stranger] = [await person("fb-v"), await person("fb-f"), await person("fb-s")]
    await befriend(viewer, friend)
    // Going, with a profile complete enough to read and ask (the board's own gates).
    const categories = await Promise.all([1, 2].map((n) => db.categories.create({ data: { name: `fb${n}-${eventId.slice(0, 8)}`, slug: `fb${n}-${eventId.slice(0, 8)}` }, select: { id: true } })))
    for (const p of [viewer, friend, stranger]) {
      const born = new Date()
      born.setFullYear(born.getFullYear() - 30)
      await db.profiles.update({ where: { id: p.id }, data: { date_of_birth: born, intent_default: ["friendship"] } })
      await db.user_interests.createMany({ data: categories.map((c) => ({ user_id: p.id, category_id: c.id })) })
      await db.event_rsvps.create({ data: { event_id: eventId, user_id: p.id, status: "going" } })
    }
    const post = async (author: Person) =>
      (await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "offer", body: "two seats", spaces_left: 2 }, select: { id: true } })).id
    const [friendsPost, strangersPost] = [await post(friend), await post(stranger)]
    const route = await import("@/app/api/mobile/events/[eventId]/board/route")
    const askRoute = await import("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route")
    const board = await api_call(route.GET, `/api/mobile/events/${eventId}/board`, viewer, { params: { eventId } })
    const ids = (board.body.data.posts as { id: string }[]).map((p) => p.id)
    expect(ids).not.toContain(friendsPost)
    void strangersPost
    const ask = (postId: string) => api_call(askRoute.POST, `/api/mobile/events/${eventId}/board/${postId}/requests`, viewer, { method: "POST", body: {}, params: { eventId, postId } })
    const toFriend = await ask(friendsPost)
    // The comparator: a post by somebody who blocked the viewer.
    const blocker = await person("fb-b")
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: blocker.id, status: "going" } })
    await db.blocked_users.create({ data: { blocker_id: blocker.id, blocked_id: viewer.id } })
    const blockedPost = await post(blocker)
    const toBlocked = await ask(blockedPost)
    expect([toFriend.status, toFriend.body.error]).toEqual([toBlocked.status, toBlocked.body.error])
    expect(toFriend.status).toBe(404)
    expect(await db.board_requests.count({ where: { event_id: eventId, from_user_id: viewer.id } })).toBe(0)
  })
})

describe("seating and ratings", () => {
  it("two accepted askers who are friends are not seated together in the post's room; a stranger is", async () => {
    const host = await person("fs-host")
    const { eventId } = await liveEvent(host.id)
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() + 24 * 3600_000), end_time: new Date(Date.now() + 27 * 3600_000) } })
    const [author, one, two, three] = [await person("fs-a"), await person("fs-1"), await person("fs-2"), await person("fs-3")]
    const categories = await Promise.all([1, 2].map((n) => db.categories.create({ data: { name: `fs${n}-${eventId.slice(0, 8)}`, slug: `fs${n}-${eventId.slice(0, 8)}` }, select: { id: true } })))
    for (const p of [author, one, two, three]) {
      const born = new Date()
      born.setFullYear(born.getFullYear() - 30)
      await db.profiles.update({ where: { id: p.id }, data: { date_of_birth: born, intent_default: ["friendship"] } })
      await db.user_interests.createMany({ data: categories.map((c) => ({ user_id: p.id, category_id: c.id })) })
      await db.event_rsvps.create({ data: { event_id: eventId, user_id: p.id, status: "going" } })
    }
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "offer", body: "three seats", spaces_left: 3 }, select: { id: true } })
    const askRoute = await import("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route")
    const decide = await import("@/app/api/mobile/board/requests/[requestId]/route")
    const requestOf = async (p: Person) => {
      const res = await api_call(askRoute.POST, `/api/mobile/events/${eventId}/board/${post.id}/requests`, p, { method: "POST", body: {}, params: { eventId, postId: post.id } })
      expect(res.status).toBe(201)
      return res.body.data.id as string
    }
    const ids = [await requestOf(one), await requestOf(two), await requestOf(three)]
    // `one` and `two` became friends after asking.
    await befriend(one, two)
    for (const id of ids) {
      const res = await api_call(decide.PATCH, `/api/mobile/board/requests/${id}`, author, { method: "PATCH", body: { action: "accept" }, params: { requestId: id } })
      expect(res.status).toBe(200)
    }
    const room = await db.chat_groups.findUniqueOrThrow({ where: { board_post_id: post.id }, select: { members: { select: { user_id: true } } } })
    const seated = room.members.map((m) => m.user_id)
    expect(seated).toContain(author.id)
    expect(seated).toContain(three.id)
    // Friends across the seats are kept apart: not both.
    expect(seated.includes(one.id) && seated.includes(two.id)).toBe(false)
  })

  it("friends are not rated as strangers: a legacy match between friends is not listed, nor counted in the rating push", async () => {
    const { ratablePeers } = await import("@/lib/trust")
    const { rateRequestAudience } = await import("@/lib/services/event-notifications.service")
    const host = await person("fr-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - 4 * 3600_000), end_time: new Date(Date.now() - 3600_000) } })
    const [me, friend, other] = [await person("fr-me"), await person("fr-f"), await person("fr-o")]
    for (const p of [me, friend, other]) await arrive(eventId, occurrenceId, p)
    await befriend(me, friend)
    for (const x of [friend, other]) {
      const [user1_id, user2_id] = [me.id, x.id].sort()
      await db.private_conversations.create({
        data: { user1_id, user2_id, origin_event_id: eventId, user1_pseudonym: "Otter", user2_pseudonym: "Heron", user1_revealed: true, user2_revealed: true },
      })
    }
    expect((await ratablePeers(eventId, me.id)).map((p) => p.userId)).toEqual([other.id])
    const audience = await rateRequestAudience(eventId)
    expect(audience.withPeers).toContain(me.id)
    expect(audience.withPeers).toContain(other.id)
    // `friend` has only the friend `me` as a match: nobody to rate.
    expect(audience.withPeers).not.toContain(friend.id)
    await db.private_conversations.deleteMany({ where: { origin_event_id: eventId } })
  })
})

async function api_call(handler: unknown, path: string, as: Person, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const { call } = await import("./crew-world")
  return call(handler, path, as, opts)
}
