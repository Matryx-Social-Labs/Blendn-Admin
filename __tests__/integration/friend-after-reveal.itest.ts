import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { revealedMatch } from "@/lib/friends"

import { cleanup, closeDb, db, makeUser, onboard } from "./helpers"

/**
 * "If users have matched and they have revealed themselves we can then give an
 * option to add as friend" (owner, 2026-10-22).
 *
 * A friend request by user id is allowed for exactly one relationship: an open
 * conversation that came from a match, both sides revealed. Every other
 * refusal answers byte-for-byte like an id nobody has; the single addition is
 * `reasonCode: NOT_A_REVEALED_MATCH` for a matched pair who have not both
 * revealed — they know they matched, so it tells them nothing new.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const invite = require("@/app/api/mobile/friends/invite/route") as typeof import("@/app/api/mobile/friends/invite/route")
const requests = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const requestById = require("@/app/api/mobile/friends/requests/[requestId]/route") as typeof import("@/app/api/mobile/friends/requests/[requestId]/route")
const conversations = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")
const conversation = require("@/app/api/mobile/conversations/[conversationId]/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/route")
const profile = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>

const users: string[] = []

interface Person {
  id: string
  token: string
}

async function person(label: string, name: string): Promise<Person> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name } })
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

const ask = (as: Person, body: { token: string } | { userId: string }) =>
  call(requests.POST as Handler, "/api/mobile/friends/requests", as, { method: "POST", body })
const incoming = async (as: Person) =>
  (await call(requests.GET as Handler, "/api/mobile/friends/requests", as)).body.data.incoming as { id: string }[]
const accept = (as: Person, requestId: string) =>
  call(requestById.POST as Handler, `/api/mobile/friends/requests/${requestId}`, as, {
    method: "POST",
    body: { action: "accept" },
    params: { requestId },
  })
const detail = (as: Person, id: string) =>
  call(conversation.GET as Handler, `/api/mobile/conversations/${id}`, as, { params: { conversationId: id } })
const inbox = async (as: Person) => (await call(conversations.GET as Handler, "/api/mobile/conversations", as)).body.data.conversations as {
  id: string
  friend: unknown
}[]
const profileOf = (as: Person, userId: string) =>
  call(profile.GET as Handler, `/api/mobile/profiles/${userId}`, as, { params: { userId } })

interface Match {
  matched?: boolean
  /** [first side by id order, second side] */
  revealed?: [boolean, boolean]
  closed?: boolean
  board?: boolean
}

/** A conversation between two people, as a match unless said otherwise. */
async function converse(a: Person, b: Person, o: Match = {}) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  const matched = o.matched ?? true
  const [r1, r2] = o.revealed ?? [true, true]
  const row = await db.private_conversations.create({
    data: {
      user1_id,
      user2_id,
      ...(matched && { user1_pseudonym: "Otter", user2_pseudonym: "Heron" }),
      user1_revealed: r1,
      user2_revealed: r2,
      ...(o.closed && { closed_at: new Date(), closed_by: a.id, closed_reason: "unmatch" }),
    },
  })
  return row.id
}

const notificationsOf = async (userId: string) => {
  for (let i = 0; i < 30; i++) {
    const rows = await db.notifications.findMany({ where: { user_id: userId, kind: "friend_request" } })
    if (rows.length) return rows
    await new Promise((r) => setTimeout(r, 100))
  }
  return []
}

afterAll(async () => {
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, [])
  await closeDb()
})

describe("POST /friends/requests { userId }", () => {
  it("is allowed for an open match both people revealed in, notifies once with via=match, and is idempotent", async () => {
    const [ana, ben] = [await person("far-ok-a", "Ana"), await person("far-ok-b", "Ben")]
    await converse(ana, ben)
    expect(await revealedMatch(ana.id, ben.id)).toBe(true)

    expect(await ask(ana, { userId: ben.id })).toMatchObject({ status: 200, body: { data: { state: "requested" } } })
    const [note] = await notificationsOf(ben.id)
    expect(note.data).toMatchObject({ type: "friend_request", via: "match" })
    // Never where they met.
    expect(JSON.stringify(note.data)).not.toMatch(/event|room|chatGroup/i)

    const again = await ask(ana, { userId: ben.id })
    expect(again.body.data).toEqual({ state: "requested" })
    await new Promise((r) => setTimeout(r, 300))
    expect(await db.notifications.count({ where: { user_id: ben.id, kind: "friend_request" } })).toBe(1)
    expect(await db.friend_requests.count({ where: { sender_id: ana.id, recipient_id: ben.id } })).toBe(1)
  })

  it("asking someone who already asked you makes you friends", async () => {
    const [ana, ben] = [await person("far-mut-a", "Ana"), await person("far-mut-b", "Ben")]
    await converse(ana, ben)
    await ask(ana, { userId: ben.id })
    expect((await ask(ben, { userId: ana.id })).body.data).toEqual({ state: "friends" })
  })

  it("answers an incomplete reveal as unknown plus NOT_A_REVEALED_MATCH, to the matched asker only", async () => {
    const unknown = (await ask(await person("far-u-x", "Xan"), { userId: "no-such-user" })).body
    for (const revealed of [[true, false], [false, true], [false, false]] as [boolean, boolean][]) {
      const [ana, ben] = [await person("far-in-a", "Ana"), await person("far-in-b", "Ben")]
      await converse(ana, ben, { revealed })
      const res = await ask(ana, { userId: ben.id })
      expect(res.status).toBe(404)
      expect(res.body.reasonCode).toBe("NOT_A_REVEALED_MATCH")
      const { reasonCode: _reason, ...rest } = res.body
      expect(rest).toEqual(unknown)
      expect(await db.friend_requests.count({ where: { sender_id: ana.id } })).toBe(0)
      // The other side asks the same.
      expect((await ask(ben, { userId: ana.id })).body.reasonCode).toBe("NOT_A_REVEALED_MATCH")
    }
  })

  it.each([
    ["a closed conversation", { closed: true }],
    ["a message-request conversation, which is not a match", { matched: false }],
  ])("refuses %s exactly as an unknown id", async (_name, match: Match) => {
    const [ana, ben] = [await person("far-no-a", "Ana"), await person("far-no-b", "Ben")]
    await converse(ana, ben, match)
    const unknown = await ask(ana, { userId: "no-such-user" })
    expect(await ask(ana, { userId: ben.id })).toEqual(unknown)
    expect(unknown.body.reasonCode).toBeUndefined()
  })

  it("refuses a pending-reveal pair exactly as unknown once closed, blocked either way, or deleted", async () => {
    const unknown = await ask(await person("far-ref-u", "Xan"), { userId: "no-such-user" })
    // Each person is both fully revealed and half revealed: no reasonCode may leak from either.
    for (const revealed of [[true, true], [true, false]] as [boolean, boolean][]) {
      const [ana, ben, cam, dee, eve] = [
        await person("far-b-a", "Ana"),
        await person("far-b-b", "Ben"),
        await person("far-b-c", "Cam"),
        await person("far-b-d", "Dee"),
        await person("far-b-e", "Eve"),
      ]
      for (const other of [ben, cam, dee, eve]) await converse(ana, other, { revealed })
      await db.blocked_users.create({ data: { blocker_id: ana.id, blocked_id: ben.id } })
      await db.blocked_users.create({ data: { blocker_id: cam.id, blocked_id: ana.id } })
      await db.user.update({ where: { id: dee.id }, data: { deletedAt: new Date() } })
      await db.private_conversations.updateMany({
        where: { OR: [{ user1_id: eve.id }, { user2_id: eve.id }] },
        data: { closed_at: new Date() },
      })
      for (const other of [ben, cam, dee, eve]) {
        expect(await ask(ana, { userId: other.id })).toEqual(unknown)
        expect(await revealedMatch(ana.id, other.id)).toBe(false)
      }
    }
  })

  it("refuses a stranger who was revealed in a room, with no match, as unknown", async () => {
    const [ana, ben] = [await person("far-room-a", "Ana"), await person("far-room-b", "Ben")]
    const unknown = await ask(ana, { userId: "no-such-user" })
    // `friends_see_me_in_rooms` is the other way a user id used to get through.
    await db.profiles.update({ where: { id: ben.id }, data: { friends_see_me_in_rooms: true } })
    expect(await ask(ana, { userId: ben.id })).toEqual(unknown)
  })

  it("leaves the invite link alone: a stranger with the token still asks, with no via", async () => {
    const [ana, ben] = [await person("far-tok-a", "Ana"), await person("far-tok-b", "Ben")]
    const token = (await call(invite.GET as Handler, "/api/mobile/friends/invite", ana)).body.data.token as string
    expect((await ask(ben, { token })).body.data).toEqual({ state: "requested" })
    const [note] = await notificationsOf(ana.id)
    expect(note.data).not.toHaveProperty("via")
  })
})

describe("the friend offer on conversations and profiles", () => {
  it("walks none, requested, incoming, friends on the detail and the inbox", async () => {
    const [ana, ben] = [await person("far-st-a", "Ana"), await person("far-st-b", "Ben")]
    const id = await converse(ana, ben)
    const seen = async (p: Person) => ({
      detail: (await detail(p, id)).body.data.friend,
      inbox: (await inbox(p)).find((c) => c.id === id)?.friend,
    })
    const both = (friend: unknown) => ({ detail: friend, inbox: friend })

    expect(await seen(ana)).toEqual(both({ state: "none", canAdd: true }))
    await ask(ana, { userId: ben.id })
    expect(await seen(ana)).toEqual(both({ state: "requested", canAdd: false }))
    // They can add back (it accepts), and the state says why.
    expect(await seen(ben)).toEqual(both({ state: "incoming", canAdd: true }))
    const [req] = await incoming(ben)
    expect((await accept(ben, req.id)).status).toBe(200)
    expect(await seen(ana)).toEqual(both({ state: "friends", canAdd: false }))
    expect(await seen(ben)).toEqual(both({ state: "friends", canAdd: false }))
  })

  it("offers nothing until both revealed, nor for a message request, and gives a pseudonym no friend state", async () => {
    const [ana, ben, cam, dee] = [
      await person("far-of-a", "Ana"),
      await person("far-of-b", "Ben"),
      await person("far-of-c", "Cam"),
      await person("far-of-d", "Dee"),
    ]
    const [user1_id] = conversationPair(ana.id, ben.id)
    const aIsFirst = user1_id === ana.id
    // Ana has revealed, Ben has not.
    const half = await converse(ana, ben, { revealed: aIsFirst ? [true, false] : [false, true] })
    const request = await converse(ana, cam, { matched: false })
    // Dee is already Ana's friend but still a pseudonym to her: the offer must not say so.
    const hidden = await converse(ana, dee, { revealed: conversationPair(ana.id, dee.id)[0] === ana.id ? [true, false] : [false, true] })
    const [x, y] = conversationPair(ana.id, dee.id)
    await db.friendships.create({ data: { user1_id: x, user2_id: y } })

    expect((await detail(ana, half)).body.data.friend).toEqual({ state: "none", canAdd: false })
    expect((await detail(ben, half)).body.data.friend).toEqual({ state: "none", canAdd: false })
    expect((await detail(ana, request)).body.data.friend).toEqual({ state: "none", canAdd: false })
    expect((await detail(ana, hidden)).body.data.friend).toEqual({ state: "none", canAdd: false })
    const list = await inbox(ana)
    expect(list.find((c) => c.id === hidden)?.friend).toEqual({ state: "none", canAdd: false })
  })

  it("rides on the profile of a revealed match, and on nobody else's", async () => {
    const [ana, ben, stranger] = [await person("far-pr-a", "Ana"), await person("far-pr-b", "Ben"), await person("far-pr-s", "Sam")]
    await converse(ana, ben)
    expect((await profileOf(ana, ben.id)).body.data.friend).toEqual({ state: "none", canAdd: true })
    await ask(ana, { userId: ben.id })
    expect((await profileOf(ana, ben.id)).body.data.friend).toEqual({ state: "requested", canAdd: false })
    expect((await profileOf(ben, ana.id)).body.data.friend).toEqual({ state: "incoming", canAdd: true })

    // A stranger gets no `friend` key at all, and neither does the owner of the profile.
    expect(await profileOf(ana, stranger.id)).toMatchObject({ status: 200 })
    expect((await profileOf(ana, stranger.id)).body.data).not.toHaveProperty("friend")
    expect((await profileOf(ana, ana.id)).body.data).not.toHaveProperty("friend")
  })
})
