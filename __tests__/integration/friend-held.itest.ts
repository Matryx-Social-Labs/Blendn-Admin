import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { friendState, lockPair } from "@/lib/friends"
import { likeAtEvent, revealConversationsFrom } from "@/lib/matches"
import { roomHandle } from "@/lib/room-handle"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard } from "./helpers"

/**
 * Friends, and a pair who are still pseudonyms to each other.
 *
 * Friendship names people on every friend surface and offers the DM beside the
 * name, and the DM between a match that has not been revealed is still "Heron".
 * So between such a pair a friend request is HELD: recorded and answered
 * "requested" (the asker is told nothing different), but not pushed, not listed,
 * not acceptable, until both have revealed; then it is delivered. And a pair who
 * already know each other never match again: nothing opens that would hand back
 * the old DM or link a second pseudonym to the first.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const invite = require("@/app/api/mobile/friends/invite/route") as typeof import("@/app/api/mobile/friends/invite/route")
const requests = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const requestById = require("@/app/api/mobile/friends/requests/[requestId]/route") as typeof import("@/app/api/mobile/friends/requests/[requestId]/route")
const friendRoute = require("@/app/api/mobile/friends/[userId]/route") as typeof import("@/app/api/mobile/friends/[userId]/route")
const friendDm = require("@/app/api/mobile/friends/[userId]/conversation/route") as typeof import("@/app/api/mobile/friends/[userId]/conversation/route")
const revealRoute = require("@/app/api/mobile/conversations/[conversationId]/reveal/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/reveal/route")
const leaveRoute = require("@/app/api/mobile/conversations/[conversationId]/leave/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/leave/route")
const likesRoute = require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route")
const ratings = require("@/app/api/mobile/events/[eventId]/peer-ratings/route") as typeof import("@/app/api/mobile/events/[eventId]/peer-ratings/route")
const boardDecide = require("@/app/api/mobile/board/requests/[requestId]/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/route")
const inboxRoute = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}
const users: string[] = []
const events: string[] = []

async function person(label: string, name: string): Promise<Person> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name, photos: [`https://img.invalid/${label}.jpg`] } })
  await db.user.update({ where: { id }, data: { name } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(handler: Handler, path: string, as: Person, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const res = await handler(
    new NextRequest(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve(opts.params ?? {}) as Promise<never> }
  )
  return { status: res.status, body: await res.json() }
}

const linkOf = async (p: Person) => (await call(invite.GET as Handler, "/api/mobile/friends/invite", p)).body.data.token as string
const ask = (as: Person, body: { token: string } | { userId: string }) =>
  call(requests.POST as Handler, "/api/mobile/friends/requests", as, { method: "POST", body })
const incoming = async (as: Person) => (await call(requests.GET as Handler, "/api/mobile/friends/requests", as)).body.data.incoming as { id: string }[]
const outgoing = async (as: Person) => (await call(requests.GET as Handler, "/api/mobile/friends/requests", as)).body.data.outgoing as { id: string }[]
const accept = (as: Person, requestId: string) =>
  call(requestById.POST as Handler, `/api/mobile/friends/requests/${requestId}`, as, { method: "POST", body: { action: "accept" }, params: { requestId } })
const friendCard = (as: Person, userId: string) => call(friendRoute.GET as Handler, `/api/mobile/friends/${userId}`, as, { params: { userId } })
const friendDmOpen = (as: Person, userId: string) => call(friendDm.POST as Handler, `/api/mobile/friends/${userId}/conversation`, as, { method: "POST", params: { userId } })
const reveal = (as: Person, id: string) =>
  call(revealRoute.POST as Handler, `/api/mobile/conversations/${id}/reveal`, as, { method: "POST", params: { conversationId: id } })
const leave = (as: Person, id: string) =>
  call(leaveRoute.POST as Handler, `/api/mobile/conversations/${id}/leave`, as, { method: "POST", body: {}, params: { conversationId: id } })

async function pseudonymousPair(a: Person, b: Person, o: { origin_event_id?: string; revealed?: { a?: boolean; b?: boolean } } = {}) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  const [ra, rb] = [!!o.revealed?.a, !!o.revealed?.b]
  const row = await db.private_conversations.create({
    data: {
      user1_id,
      user2_id,
      user1_pseudonym: "Otter",
      user2_pseudonym: "Heron",
      user1_revealed: user1_id === a.id ? ra : rb,
      user2_revealed: user1_id === a.id ? rb : ra,
      ...(o.origin_event_id && { origin_event_id: o.origin_event_id }),
    },
  })
  return row.id
}
const friendsRow = async (a: Person, b: Person) => {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  await db.friendships.create({ data: { user1_id, user2_id } })
}
const friendshipCount = (a: Person) => db.friendships.count({ where: { OR: [{ user1_id: a.id }, { user2_id: a.id }] } })
const pushes = async (userId: string, settle = 400) => {
  await new Promise((r) => setTimeout(r, settle))
  return db.notifications.findMany({ where: { user_id: userId, kind: "friend_request" } })
}

afterAll(async () => {
  await db.event_likes.deleteMany({ where: { OR: [{ liker_id: { in: users } }, { liked_id: { in: users } }] } })
  await db.peer_ratings.deleteMany({ where: { OR: [{ rater_id: { in: users } }, { rated_id: { in: users } }] } })
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, events)
  await closeDb()
})

describe("a friend request between people who are still pseudonyms", () => {
  it("is recorded and told 'requested', but not pushed, listed, shown or acceptable", async () => {
    const [ana, ben] = [await person("fh-1a", "Ana"), await person("fh-1b", "Ben")]
    const id = await pseudonymousPair(ana, ben)
    expect((await ask(ben, { token: await linkOf(ana) })).body.data).toEqual({ state: "requested" })

    const row = await db.friend_requests.findFirstOrThrow({ where: { sender_id: ben.id, recipient_id: ana.id } })
    expect(row.held_at).not.toBeNull()
    expect(await pushes(ana.id)).toEqual([])
    expect(await incoming(ana)).toEqual([])
    expect((await outgoing(ben)).map((r) => r.id)).toEqual([row.id]) // the asker is told nothing different
    expect(await friendState(ana.id, ben.id)).toBe("none")
    expect(await friendState(ben.id, ana.id)).toBe("requested")
    // Even by its id the recipient cannot accept it.
    expect((await accept(ana, row.id)).status).toBe(404)
    expect(await friendshipCount(ana)).toBe(0)

    // Asking back is not an accept either: nobody is a friend until both have revealed.
    expect((await ask(ana, { token: await linkOf(ben) })).body.data).toEqual({ state: "requested" })
    expect(await friendshipCount(ana)).toBe(0)
    void id
  })

  it("is delivered by the reveal that makes both of them names: listed, pushed once, acceptable", async () => {
    const [ana, ben] = [await person("fh-2a", "Ana"), await person("fh-2b", "Ben")]
    const id = await pseudonymousPair(ana, ben)
    await ask(ben, { token: await linkOf(ana) })

    expect((await reveal(ana, id)).status).toBe(200)
    expect(await incoming(ana)).toEqual([]) // one side is not both
    expect(await pushes(ana.id, 200)).toEqual([])

    expect((await reveal(ben, id)).status).toBe(200)
    const [req] = await incoming(ana)
    expect(req).toBeDefined()
    expect((await pushes(ana.id)).length).toBe(1)
    expect((await db.friend_requests.findUniqueOrThrow({ where: { id: req.id } })).held_at).toBeNull()
    expect(await friendState(ana.id, ben.id)).toBe("incoming")
    expect((await accept(ana, req.id)).status).toBe(200)
    expect(await friendshipCount(ana)).toBe(1)
  })

  it("two people who each asked become friends when the reveal releases them", async () => {
    const [ana, ben] = [await person("fh-3a", "Ana"), await person("fh-3b", "Ben")]
    const id = await pseudonymousPair(ana, ben)
    await ask(ben, { token: await linkOf(ana) })
    await ask(ana, { token: await linkOf(ben) })
    await reveal(ana, id)
    await reveal(ben, id)
    expect(await friendshipCount(ana)).toBe(1)
    expect(await db.friend_requests.count({ where: { OR: [{ sender_id: ana.id }, { sender_id: ben.id }] } })).toBe(0)
  })

  it("a reveal in the room carries into the DM and releases it too", async () => {
    const [ana, ben] = [await person("fh-4a", "Ana"), await person("fh-4b", "Ben")]
    const host = await makeUser("fh-host", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await pseudonymousPair(ana, ben, { origin_event_id: eventId })
    await ask(ben, { token: await linkOf(ana) })
    await revealConversationsFrom(eventId, [ana.id])
    expect(await incoming(ana)).toEqual([])
    await revealConversationsFrom(eventId, [ben.id])
    expect((await incoming(ana)).length).toBe(1)
    expect((await pushes(ana.id)).length).toBe(1)
  })

  it("never lands after an unmatch: the pair is closed as it always was", async () => {
    const [ana, ben] = [await person("fh-5a", "Ana"), await person("fh-5b", "Ben")]
    const id = await pseudonymousPair(ana, ben)
    await ask(ben, { token: await linkOf(ana) })
    expect((await leave(ana, id)).status).toBe(200)
    const row = await db.friend_requests.findFirstOrThrow({ where: { sender_id: ben.id, recipient_id: ana.id } })
    expect((await accept(ana, row.id)).status).toBe(404)
    expect(await friendshipCount(ana)).toBe(0)
  })
})

describe("friends who are still pseudonyms in a DM", () => {
  it("get no DM from the friend card: no conversationId, and the open call answers as a closed pair does", async () => {
    const [ana, ben] = [await person("fh-6a", "Ana"), await person("fh-6b", "Ben")]
    const id = await pseudonymousPair(ana, ben)
    await friendsRow(ana, ben)

    expect((await friendCard(ana, ben.id)).body.data.conversationId).toBeNull()
    const open = await friendDmOpen(ana, ben.id)
    expect(open.status).toBe(409)
    expect(open.body.error).toBe("This conversation was closed and cannot be reopened")
    expect(await db.private_conversations.count({ where: { id } })).toBe(1)

    // Once both revealed it is an ordinary DM again.
    await reveal(ana, id)
    await reveal(ben, id)
    expect((await friendCard(ana, ben.id)).body.data.conversationId).toBe(id)
    expect((await friendDmOpen(ana, ben.id)).body.data.conversationId).toBe(id)
  })
})

describe("a pair who already know each other never match again (M2, L4)", () => {
  async function ended(...people: Person[]) {
    const host = await makeUser("fh-lhost", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { end_time: new Date(Date.now() - 60 * 1000) } })
    const occurrence_id = await occurrenceOf(eventId)
    for (const p of people) {
      await db.event_check_ins.create({ data: { user_id: p.id, event_id: eventId, occurrence_id, check_in_time: new Date(), status: "checked_in" } })
    }
    return eventId
  }
  const like = (as: Person, eventId: string, who: Person) =>
    call(likesRoute.POST as Handler, `/api/mobile/events/${eventId}/matches/likes`, as, {
      method: "POST",
      body: { userId: roomHandle(eventId, who.id) },
      params: { eventId },
    })

  it.each([
    ["a real-name conversation", "conversation"],
    ["a pseudonymous one from another event", "pseudonymous"],
    ["a friend request waiting", "request"],
    ["a friendship and no conversation", "friendship"],
  ])("answers a mutual like between people with %s as a like nobody returned", async (_n, kind) => {
    const [ana, ben, cam] = [await person(`fh-m-${kind}-a`, "Ana"), await person(`fh-m-${kind}-b`, "Ben"), await person(`fh-m-${kind}-c`, "Cam")]
    const eventId = await ended(ana, ben, cam)
    const control = await like(ana, eventId, cam) // nobody returned
    const [user1_id, user2_id] = conversationPair(ana.id, ben.id)
    if (kind === "conversation") await db.private_conversations.create({ data: { user1_id, user2_id } })
    if (kind === "pseudonymous") await pseudonymousPair(ana, ben)
    if (kind === "friendship") await db.friendships.create({ data: { user1_id, user2_id } })
    if (kind === "request") await db.friend_requests.create({ data: { sender_id: ana.id, recipient_id: ben.id } })

    await like(ben, eventId, ana)
    const answer = await like(ana, eventId, ben)
    expect(answer).toEqual(control)
    const rows = await db.private_conversations.findMany({ where: { OR: [{ user1_id: ana.id, user2_id: ben.id }, { user1_id: ben.id, user2_id: ana.id }] } })
    expect(rows.every((r) => r.origin_event_id === null)).toBe(true)
  })

  it("takes the pair's lock around the check and the write, and a stranger pair still matches", async () => {
    const [ana, ben] = [await person("fh-ml-a", "Ana"), await person("fh-ml-b", "Ben")]
    const eventId = await ended(ana, ben)
    await like(ben, eventId, ana)
    const out = await likeAtEvent(eventId, ana.id, ben.id)
    expect(out.mutual).toBe(true)
    // Both sides are pseudonymous even when the room named neither: "Attendee", never null.
    const row = await db.private_conversations.findFirstOrThrow({ where: { origin_event_id: eventId } })
    expect([row.user1_pseudonym, row.user2_pseudonym]).toEqual(["Attendee", "Attendee"])
  })
})

describe("the like takes the pair's lock (L4)", () => {
  it("a friendship that lands while the like waits for the lock still stops the match", async () => {
    const [ana, ben] = [await person("fh-lk-a", "Ana"), await person("fh-lk-b", "Ben")]
    const host = await makeUser("fh-lkhost", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.event_likes.create({ data: { event_id: eventId, liker_id: ben.id, liked_id: ana.id } })

    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => (locked = r))
    const holder = db.$transaction(async (tx) => {
      await lockPair(tx, ana.id, ben.id)
      locked()
      await held
    }, { timeout: 20_000 })
    await lockTaken
    const pending = likeAtEvent(eventId, ana.id, ben.id)
    for (let i = 0; i < 100; i++) {
      const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
      if (Number(n) > 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await friendsRow(ana, ben)
    release()
    await holder
    expect(await pending).toEqual({ mutual: false })
    expect(await db.private_conversations.count({ where: { origin_event_id: eventId } })).toBe(0)
  })
})

describe("who you may rate (H2)", () => {
  async function ended(...people: Person[]) {
    const host = await makeUser("fh-rhost", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { end_time: new Date(Date.now() - 60 * 1000) } })
    return { eventId, occurrence_id: await occurrenceOf(eventId), people }
  }
  const list = (as: Person, eventId: string) =>
    call(ratings.GET as Handler, `/api/mobile/events/${eventId}/peer-ratings`, as, { params: { eventId } })
  const rate = (as: Person, eventId: string, userId: string) =>
    call(ratings.POST as Handler, `/api/mobile/events/${eventId}/peer-ratings`, as, { method: "POST", body: { userId, rating: 4 }, params: { eventId } })

  it("lists matches made at this event by the conversation's handle, and takes only that back until they reveal", async () => {
    const [ana, ben, cam] = [await person("fh-r-a", "Ana"), await person("fh-r-b", "Ben"), await person("fh-r-c", "Cam")]
    const { eventId } = await ended(ana, ben, cam)
    const id = await pseudonymousPair(ana, ben, { origin_event_id: eventId })
    // A mutual like with no conversation (a friend's, say): not a match, so not listed.
    await db.event_likes.createMany({
      data: [
        { event_id: eventId, liker_id: ana.id, liked_id: cam.id },
        { event_id: eventId, liker_id: cam.id, liked_id: ana.id },
      ],
    })

    const res = await list(ana, eventId)
    const [handle] = res.body.data.userIds as string[]
    expect(res.body.data.userIds).toHaveLength(1)
    expect(handle).toMatch(/^rh_/)
    expect(JSON.stringify(res.body)).not.toContain(ben.id)
    expect(JSON.stringify(res.body)).not.toContain(cam.id)
    // The inbox names the same person the same way, so the app joins the two.
    const inbox = (await call(inboxRoute.GET as Handler, "/api/mobile/conversations", ana)).body.data.conversations
    expect(inbox.find((c: { id: string }) => c.id === id).otherUser.id).toBe(handle)

    // A raw id is not the ref for somebody still a pseudonym, whatever it is.
    expect((await rate(ana, eventId, ben.id)).status).toBe(403)
    expect((await rate(ana, eventId, handle)).status).toBe(200)
    expect((await db.peer_ratings.findFirstOrThrow({ where: { rater_id: ana.id } })).rated_id).toBe(ben.id)
    expect((await list(ana, eventId)).body.data.userIds).toEqual([])
  })

  it("is the raw id once they reveal, and a stale handle still resolves", async () => {
    const [ana, ben] = [await person("fh-r2-a", "Ana"), await person("fh-r2-b", "Ben")]
    const { eventId } = await ended(ana, ben)
    const id = await pseudonymousPair(ana, ben, { origin_event_id: eventId })
    const [handle] = (await list(ana, eventId)).body.data.userIds as string[]
    await reveal(ben, id)
    expect((await list(ana, eventId)).body.data.userIds).toEqual([ben.id])
    expect((await rate(ana, eventId, handle)).status).toBe(200)
  })

  it("leaves out a board conversation, and a block takes the person off the list", async () => {
    const [ana, ben, cam] = [await person("fh-r3-a", "Ana"), await person("fh-r3-b", "Ben"), await person("fh-r3-c", "Cam")]
    const { eventId } = await ended(ana, ben, cam)
    const [u1, u2] = conversationPair(ana.id, ben.id)
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: ben.id, kind: "seeking", body: "x" }, select: { id: true } })
    const request = await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: ana.id, to_user_id: ben.id, status: "accepted", decided_at: new Date() } })
    await db.private_conversations.create({
      data: { user1_id: u1, user2_id: u2, user1_pseudonym: "A", user2_pseudonym: "B", origin_event_id: eventId, origin_board_request_id: request.id },
    })
    await pseudonymousPair(ana, cam, { origin_event_id: eventId })
    expect((await list(ana, eventId)).body.data.userIds).toHaveLength(1)
    await db.blocked_users.create({ data: { blocker_id: ana.id, blocked_id: cam.id } })
    expect((await list(ana, eventId)).body.data.userIds).toEqual([])
  })
})

describe("a board accept between people who already know each other (M1)", () => {
  async function ask_(pair: "friends" | "conversation" | "strangers") {
    const [author, asker] = [await person(`fh-b-${pair}-a`, "Author"), await person(`fh-b-${pair}-s`, "Asker")]
    const host = await makeUser("fh-bhost", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "offer", body: "two seats", spaces_left: 2 }, select: { id: true } })
    const req = await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: asker.id, to_user_id: author.id } })
    if (pair === "friends") await friendsRow(author, asker)
    if (pair === "conversation") {
      const [user1_id, user2_id] = conversationPair(author.id, asker.id)
      await db.private_conversations.create({ data: { user1_id, user2_id } })
    }
    const res = await call(boardDecide.PATCH as Handler, `/api/mobile/board/requests/${req.id}`, author, { method: "PATCH", body: { action: "accept" }, params: { requestId: req.id } })
    return { res, postId: post.id, author, asker }
  }

  it.each(["friends", "conversation"] as const)("takes the seat and opens nothing for %s", async (pair) => {
    const { res, postId } = await ask_(pair)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe("accepted")
    expect(res.body.data.conversationId).toBeNull()
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: postId } })).spaces_left).toBe(1)
  })

  it("still opens a pseudonymous DM between strangers", async () => {
    const { res, author, asker } = await ask_("strangers")
    expect(res.status).toBe(200)
    const row = await db.private_conversations.findUniqueOrThrow({ where: { id: res.body.data.conversationId } })
    expect(row.origin_board_request_id).not.toBeNull()
    expect([row.user1_id, row.user2_id].sort()).toEqual([author.id, asker.id].sort())
  })
})
