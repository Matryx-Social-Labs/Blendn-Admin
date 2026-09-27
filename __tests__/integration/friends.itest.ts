import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { maySeeIdentity } from "@/lib/identity"
import { matchesForEvent } from "@/lib/matches"
import { conversationPair } from "@/lib/conversations"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard } from "./helpers"

/**
 * Friends, driven through the real handlers against a real database.
 *
 * Two rules are the point of this suite, and each has a test that fails if
 * the rule quietly stops holding:
 *
 * - **Nobody can be looked up.** Every refusal a stranger can reach — a bad
 *   token, a reset one, a block, a pair who left each other, a user id they
 *   have no business with — answers with the byte-identical 404 a link that
 *   never existed gets.
 * - **Friends are still pseudonyms in a room.** Being friends, and even
 *   messaging as friends, does not open `maySeeIdentity` (which every room
 *   surface asks). Only the person's own `friends_see_me_in_rooms` does.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const invite = require("@/app/api/mobile/friends/invite/route") as typeof import("@/app/api/mobile/friends/invite/route")
const invitePreview = require("@/app/api/mobile/friends/invite/[token]/route") as typeof import("@/app/api/mobile/friends/invite/[token]/route")
const requests = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const requestById = require("@/app/api/mobile/friends/requests/[requestId]/route") as typeof import("@/app/api/mobile/friends/requests/[requestId]/route")
const friends = require("@/app/api/mobile/friends/route") as typeof import("@/app/api/mobile/friends/route")
const friend = require("@/app/api/mobile/friends/[userId]/route") as typeof import("@/app/api/mobile/friends/[userId]/route")
const friendDm = require("@/app/api/mobile/friends/[userId]/conversation/route") as typeof import("@/app/api/mobile/friends/[userId]/conversation/route")
const block = require("@/app/api/mobile/users/[userId]/block/route") as typeof import("@/app/api/mobile/users/[userId]/block/route")
const profile = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

// `Promise<never>` is assignable to every route's own params type, so one
// signature covers all nine handlers without a cast to `any`.
type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>

const users: string[] = []
const events: string[] = []

interface Person {
  id: string
  token: string
}

async function person(label: string, name: string): Promise<Person> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name, photos: [`https://img.invalid/${label}.jpg`] } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(
  handler: Handler,
  path: string,
  as: Person,
  opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}
) {
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
const open = (token: string, as: Person) =>
  call(invitePreview.GET as Handler, `/api/mobile/friends/invite/${token}`, as, { params: { token } })
const ask = (as: Person, body: { token: string } | { userId: string }) =>
  call(requests.POST as Handler, "/api/mobile/friends/requests", as, { method: "POST", body })
const listRequests = (as: Person) => call(requests.GET as Handler, "/api/mobile/friends/requests", as)
const answer = (as: Person, requestId: string, action: "accept" | "dismiss") =>
  call(requestById.POST as Handler, `/api/mobile/friends/requests/${requestId}`, as, {
    method: "POST",
    body: { action },
    params: { requestId },
  })
const listFriends = (as: Person) => call(friends.GET as Handler, "/api/mobile/friends", as)
const friendProfile = (as: Person, userId: string) =>
  call(friend.GET as Handler, `/api/mobile/friends/${userId}`, as, { params: { userId } })

/** Pushes are fire-and-forget; the notifications row lands a moment after the response. */
async function notificationsOf(userId: string, kind: "friend_request" | "friend_accepted", settleMs = 0) {
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs))
  for (let i = 0; i < 30; i++) {
    const rows = await db.notifications.findMany({ where: { user_id: userId, kind } })
    if (rows.length || settleMs) return rows
    await new Promise((r) => setTimeout(r, 100))
  }
  return []
}

/** Two people who both said yes, the way the app does it. */
async function befriend(a: Person, b: Person) {
  await ask(b, { token: await linkOf(a) })
  const incoming = (await listRequests(a)).body.data.incoming as { id: string; person: { userId: string } }[]
  const req = incoming.find((r) => r.person.userId === b.id)!
  expect((await answer(a, req.id, "accept")).status).toBe(200)
}

afterAll(async () => {
  await db.private_conversations.deleteMany({
    where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] },
  })
  await cleanup(users, events)
  await closeDb()
})

describe("the invite link", () => {
  it("is made once and kept, and points at www", async () => {
    const ana = await person("fr-link", "Ana")
    const first = await call(invite.GET as Handler, "/api/mobile/friends/invite", ana)
    const again = await call(invite.GET as Handler, "/api/mobile/friends/invite", ana)
    expect(first.body.data.token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(again.body.data.token).toBe(first.body.data.token)
    // The apex redirects to www, and an association file behind a redirect
    // is refused by both platforms — so an apex link would never open the app.
    expect(first.body.data.url).toBe(`https://www.blendn.app/f/${first.body.data.token}`)
  })

  it("shows its owner's name and photo to whoever opens it", async () => {
    const [ana, ben] = [await person("fr-own", "Ana"), await person("fr-open", "Ben")]
    const res = await open(await linkOf(ana), ben)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      person: { userId: ana.id, name: "Ana", photo: "https://img.invalid/fr-own.jpg" },
      state: "none",
    })
  })

  it("answers every refusal exactly like a link that never existed", async () => {
    const [ana, ben, blocker, leaver] = [
      await person("fr-ref-a", "Ana"),
      await person("fr-ref-b", "Ben"),
      await person("fr-ref-c", "Cam"),
      await person("fr-ref-d", "Dee"),
    ]
    const token = await linkOf(ana)
    const never = await open("AAAAAAAAAAAAAAAAAAAAAA", ben)
    expect(never.status).toBe(404)

    // Malformed never reaches the database, and says the same thing.
    expect(await open("not-a-token", ben)).toEqual(never)

    // Blocked, in either direction.
    await db.blocked_users.create({ data: { blocker_id: blocker.id, blocked_id: ana.id } })
    expect(await open(token, blocker)).toEqual(never)

    // A pair who left each other: unmatch is permanent here as everywhere.
    const [user1_id, user2_id] = conversationPair(ana.id, leaver.id)
    await db.private_conversations.create({
      data: { user1_id, user2_id, closed_at: new Date(), closed_by: ana.id, closed_reason: "unmatch" },
    })
    expect(await open(token, leaver)).toEqual(never)

    // Reset: the old link is now indistinguishable from one that never was.
    const reset = await call(invite.POST as Handler, "/api/mobile/friends/invite", ana, { method: "POST" })
    expect(reset.body.data.token).not.toBe(token)
    expect(await open(token, ben)).toEqual(never)
    expect((await open(reset.body.data.token, ben)).status).toBe(200)
  })
})

describe("asking and answering", () => {
  it("a request by link reaches its owner, who can accept it", async () => {
    const [ana, ben] = [await person("fr-acc-a", "Ana"), await person("fr-acc-b", "Ben")]
    const sent = await ask(ben, { token: await linkOf(ana) })
    expect(sent.body.data).toEqual({ state: "requested" })
    expect(await notificationsOf(ana.id, "friend_request")).toHaveLength(1)

    const outgoing = (await listRequests(ben)).body.data.outgoing
    expect(outgoing.map((r: { person: { name: string } }) => r.person.name)).toEqual(["Ana"])
    const incoming = (await listRequests(ana)).body.data.incoming
    expect(incoming.map((r: { person: { name: string } }) => r.person.name)).toEqual(["Ben"])

    expect((await answer(ana, incoming[0].id, "accept")).body.data).toEqual({ state: "friends" })
    expect(await notificationsOf(ben.id, "friend_accepted")).toHaveLength(1)

    const [user1_id, user2_id] = conversationPair(ana.id, ben.id)
    expect(await db.friendships.count({ where: { user1_id, user2_id } })).toBe(1)
    expect(await db.friend_requests.count({ where: { OR: [{ sender_id: ben.id }, { sender_id: ana.id }] } })).toBe(0)

    const anasList = (await listFriends(ana)).body.data
    expect(anasList.count).toBe(1)
    expect(anasList.friends[0]).toMatchObject({ userId: ben.id, name: "Ben" })
    expect((await open(await linkOf(ana), ben)).body.data.state).toBe("friends")
  })

  it("'Not now' hides it from the recipient and is never delivered to the sender", async () => {
    const [ana, ben] = [await person("fr-nn-a", "Ana"), await person("fr-nn-b", "Ben")]
    const token = await linkOf(ana)
    await ask(ben, { token })
    const [req] = (await listRequests(ana)).body.data.incoming
    expect((await answer(ana, req.id, "dismiss")).status).toBe(200)

    expect((await listRequests(ana)).body.data.incoming).toEqual([])
    expect((await listRequests(ben)).body.data.outgoing).toHaveLength(1)
    expect((await open(token, ben)).body.data.state).toBe("requested")

    // Asking again cannot nag: same row, still dismissed, no second push.
    expect((await ask(ben, { token })).body.data).toEqual({ state: "requested" })
    expect((await listRequests(ana)).body.data.incoming).toEqual([])
    expect(await notificationsOf(ana.id, "friend_request", 300)).toHaveLength(1)
  })

  it("two people asking each other are friends at once", async () => {
    const [ana, ben] = [await person("fr-mut-a", "Ana"), await person("fr-mut-b", "Ben")]
    await ask(ben, { token: await linkOf(ana) })
    expect((await ask(ana, { token: await linkOf(ben) })).body.data).toEqual({ state: "friends" })
    expect((await listFriends(ben)).body.data.count).toBe(1)
  })

  it("accepts a user id only for someone the asker can already see", async () => {
    const [ana, ben, stranger] = [
      await person("fr-id-a", "Ana"),
      await person("fr-id-b", "Ben"),
      await person("fr-id-s", "Sam"),
    ]
    // An accepted message request: they already know each other.
    const [user1_id, user2_id] = conversationPair(ana.id, ben.id)
    await db.private_conversations.create({ data: { user1_id, user2_id } })
    expect((await ask(ana, { userId: ben.id })).body.data).toEqual({ state: "requested" })

    // Anybody else by id is a lookup, and it answers like a nonexistent id.
    const missing = await ask(ana, { userId: "no-such-user" })
    expect(missing.status).toBe(404)
    expect(await ask(ana, { userId: stranger.id })).toEqual(missing)
  })

  it("only the recipient answers, only the sender withdraws", async () => {
    const [ana, ben, eve] = [
      await person("fr-own-a", "Ana"),
      await person("fr-own-b", "Ben"),
      await person("fr-own-e", "Eve"),
    ]
    await ask(ben, { token: await linkOf(ana) })
    const [req] = (await listRequests(ana)).body.data.incoming
    expect((await answer(eve, req.id, "accept")).status).toBe(404)
    expect((await answer(ben, req.id, "accept")).status).toBe(404)
    const withdrawBy = (p: Person) =>
      call(requestById.DELETE as Handler, `/api/mobile/friends/requests/${req.id}`, p, {
        method: "DELETE",
        params: { requestId: req.id },
      })
    expect((await withdrawBy(ana)).status).toBe(404)
    expect((await withdrawBy(ben)).status).toBe(200)
    expect((await listRequests(ana)).body.data.incoming).toEqual([])
  })

  it("refuses your own link and anyone who has not finished onboarding", async () => {
    const ana = await person("fr-self", "Ana")
    const own = await ask(ana, { token: await linkOf(ana) })
    expect(own.status).toBe(400)

    const newcomer = await person("fr-new", "Nia")
    await db.profiles.update({ where: { id: newcomer.id }, data: { onboarded: false, age: null } })
    expect((await ask(newcomer, { token: await linkOf(ana) })).status).toBe(403)
  })
})

describe("a friend's profile", () => {
  it("is the identified profile for a friend and a 404 for anyone else", async () => {
    const [ana, ben, cam] = [await person("fr-pr-a", "Ana"), await person("fr-pr-b", "Ben"), await person("fr-pr-c", "Cam")]
    await befriend(ana, ben)

    const seen = await friendProfile(ana, ben.id)
    expect(seen.status).toBe(200)
    expect(seen.body.data).toMatchObject({ userId: ben.id, name: "Ben", photos: ["https://img.invalid/fr-pr-b.jpg"] })
    expect(seen.body.data).not.toHaveProperty("date_of_birth")

    const nobody = await friendProfile(cam, "no-such-user")
    expect(nobody.status).toBe(404)
    expect(await friendProfile(cam, ana.id)).toEqual(nobody)
  })

  it("unfriending is silent and leaves the DM alone", async () => {
    const [ana, ben] = [await person("fr-un-a", "Ana"), await person("fr-un-b", "Ben")]
    await befriend(ana, ben)
    const dm = await call(friendDm.POST as Handler, `/api/mobile/friends/${ben.id}/conversation`, ana, {
      method: "POST",
      params: { userId: ben.id },
    })
    const removed = await call(friend.DELETE as Handler, `/api/mobile/friends/${ben.id}`, ana, {
      method: "DELETE",
      params: { userId: ben.id },
    })
    expect(removed.status).toBe(200)
    expect((await listFriends(ben)).body.data.count).toBe(0)
    const conversation = await db.private_conversations.findUnique({ where: { id: dm.body.data.conversationId } })
    expect(conversation?.closed_at).toBeNull()
  })
})

describe("friends are still pseudonyms in a room", () => {
  it("being friends and messaging as friends does not reveal anyone", async () => {
    const [ana, ben] = [await person("fr-r3-a", "Ana"), await person("fr-r3-b", "Ben")]
    await befriend(ana, ben)
    expect(await maySeeIdentity(ana.id, ben.id)).toBe(false)

    const dm = await call(friendDm.POST as Handler, `/api/mobile/friends/${ben.id}/conversation`, ana, {
      method: "POST",
      params: { userId: ben.id },
    })
    expect(dm.status).toBe(200)
    const row = await db.private_conversations.findUnique({ where: { id: dm.body.data.conversationId } })
    expect(row?.origin_friendship).toBe(true)
    // The control: an ordinary open conversation DOES reveal, so the false
    // below is the flag working, not the gate being broken.
    expect(await maySeeIdentity(ana.id, ben.id)).toBe(false)
    expect(await maySeeIdentity(ben.id, ana.id)).toBe(false)

    // Asking again finds the same conversation.
    const again = await call(friendDm.POST as Handler, `/api/mobile/friends/${ben.id}/conversation`, ana, {
      method: "POST",
      params: { userId: ben.id },
    })
    expect(again.body.data.conversationId).toBe(dm.body.data.conversationId)
  })

  it("an ordinary conversation still reveals — the control for the test above", async () => {
    const [ana, ben] = [await person("fr-ctl-a", "Ana"), await person("fr-ctl-b", "Ben")]
    const [user1_id, user2_id] = conversationPair(ana.id, ben.id)
    await db.private_conversations.create({ data: { user1_id, user2_id } })
    expect(await maySeeIdentity(ana.id, ben.id)).toBe(true)
  })

  it("the person's own setting, and only theirs, lets friends recognise them", async () => {
    const [ana, ben, cam] = [await person("fr-set-a", "Ana"), await person("fr-set-b", "Ben"), await person("fr-set-c", "Cam")]
    await befriend(ana, ben)

    const turnedOn = await call(profile.PUT as Handler, `/api/mobile/profiles/${ben.id}`, ben, {
      method: "PUT",
      body: { friends_see_me_in_rooms: true },
      params: { userId: ben.id },
    })
    expect(turnedOn.status).toBe(200)
    expect(await maySeeIdentity(ana.id, ben.id)).toBe(true)
    // One-way: Ben's switch says nothing about Ana.
    expect(await maySeeIdentity(ben.id, ana.id)).toBe(false)
    // And it is for friends: a stranger still sees a pseudonym.
    expect(await maySeeIdentity(cam.id, ben.id)).toBe(false)
  })

  it("friends are left out of each other's match pool", async () => {
    const host = await makeUser("fr-host", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })
    const [ana, ben, cam] = [await person("fr-mp-a", "Ana"), await person("fr-mp-b", "Ben"), await person("fr-mp-c", "Cam")]
    const occurrence_id = await occurrenceOf(eventId)
    for (const p of [ana, ben, cam]) {
      await db.event_check_ins.create({
        data: { user_id: p.id, event_id: eventId, occurrence_id, check_in_time: new Date(), status: "checked_in" },
      })
    }
    expect((await matchesForEvent(eventId, ana.id))!.map((m) => m.userId).sort()).toEqual([ben.id, cam.id].sort())

    await befriend(ana, ben)
    expect((await matchesForEvent(eventId, ana.id))!.map((m) => m.userId)).toEqual([cam.id])
    expect((await matchesForEvent(eventId, ben.id))!.map((m) => m.userId)).toEqual([cam.id])
  })
})

describe("a block", () => {
  it("ends the friendship and any request, and the link stops working for them", async () => {
    const [ana, ben, cam] = [await person("fr-bl-a", "Ana"), await person("fr-bl-b", "Ben"), await person("fr-bl-c", "Cam")]
    await befriend(ana, ben)
    await ask(cam, { token: await linkOf(ana) })

    for (const target of [ben, cam]) {
      const res = await call(block.POST as Handler, `/api/mobile/users/${target.id}/block`, ana, {
        method: "POST",
        params: { userId: target.id },
      })
      expect(res.status).toBeLessThan(300)
    }

    expect((await listFriends(ana)).body.data.count).toBe(0)
    expect((await listRequests(ana)).body.data.incoming).toEqual([])
    expect((await friendProfile(ben, ana.id)).status).toBe(404)
    expect((await open(await linkOf(ana), ben)).status).toBe(404)
    expect(
      (
        await call(friendDm.POST as Handler, `/api/mobile/friends/${ana.id}/conversation`, ben, {
          method: "POST",
          params: { userId: ana.id },
        })
      ).status
    ).toBe(404)
  })
})
