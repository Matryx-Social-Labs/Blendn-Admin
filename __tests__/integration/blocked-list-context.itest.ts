/*
 * `GET /users/blocked` tells one "Someone" from another (SCRUM-1082, SCRUM-1076):
 * each block keeps the pseudonym the blocker was shown and where they blocked
 * from, written by every door; a deleted account says so; `?q=` searches on the
 * server over what the list may show, and never over a name it may not.
 */
import { randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { signAccessToken } from "@/lib/mobile-auth"
import { roomHandle } from "@/lib/room-handle"
import { leaveConversationIn } from "@/lib/leave-conversation"
import { conversationPair } from "@/lib/conversations"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const blockRoute = require("@/app/api/mobile/users/[userId]/block/route") as typeof import("@/app/api/mobile/users/[userId]/block/route")
const listRoute = require("@/app/api/mobile/users/blocked/route") as typeof import("@/app/api/mobile/users/blocked/route")
const respondRoute = require("@/app/api/mobile/message-requests/[requestId]/respond/route") as typeof import("@/app/api/mobile/message-requests/[requestId]/respond/route")
const postBlock = require("@/app/api/mobile/events/[eventId]/board/[postId]/block/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/block/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []

interface Row {
  blocked_id: string
  blocked_user_name: string | null
  seen_as: string | null
  seen_in: string | null
  account_deleted: boolean
  blocked_at: string
}
interface ListBody {
  users: Row[]
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null; totalCount: number }
}

afterAll(async () => {
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string, name = `Test ${label}`) {
  const id = await makeUser(label)
  await db.user.update({ where: { id }, data: { name } })
  await onboard(id)
  users.push(id)
  return id
}
const tokenOf = async (id: string) => signAccessToken(id, (await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })).email)

async function event(title: string) {
  const host = await person("host")
  const id = await makeEvent(host)
  await db.events.update({ where: { id }, data: { title } })
  events.push(id)
  return id
}

async function block(blockerId: string, ref: string) {
  const res = await blockRoute.POST(
    new NextRequest(`http://localhost/api/mobile/users/${ref}/block`, { method: "POST", headers: { authorization: `Bearer ${await tokenOf(blockerId)}` } }),
    { params: Promise.resolve({ userId: ref }) }
  )
  expect(res.status).toBe(200)
}

async function list(blockerId: string, query = ""): Promise<{ status: number; body: ListBody; text: string }> {
  const res = await listRoute.GET(
    new NextRequest(`http://localhost/api/mobile/users/blocked${query}`, { headers: { authorization: `Bearer ${await tokenOf(blockerId)}` } })
  )
  const text = await res.text()
  return { status: res.status, body: res.status === 200 ? (JSON.parse(text).data as ListBody) : (null as unknown as ListBody), text }
}

describe("what each door records", () => {
  it("a block from an event's room keeps the room's pseudonym and the event, and the list says no name", async () => {
    const eventId = await event(`Rooftop Mixer ${testId("t")}`)
    const [me, them] = [await person("ctx-room-me"), await person("ctx-room-them", "Priya Raman")]
    const pseudonym = `Velvet Otter ${randomUUID().slice(0, 6)}`
    await db.chat_groups.create({
      data: { kind: "event", event_id: eventId, name: "room", members: { create: [{ user_id: them, anonymous_name: pseudonym }, { user_id: me }] } },
    })

    await block(me, roomHandle(eventId, them))

    const row = await db.blocked_users.findFirstOrThrow({ where: { blocker_id: me, blocked_id: them } })
    const title = (await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { title: true } })).title
    expect(row).toMatchObject({ seen_as: pseudonym, seen_in: title })

    const { body, text } = await list(me)
    expect(body.users).toEqual([expect.objectContaining({ blocked_user_name: null, seen_as: pseudonym, seen_in: title, account_deleted: false })])
    expect(text).not.toContain("Priya")
    expect(text).not.toContain(them)
  })

  it("a block from a board post keeps the board's pseudonym and the event", async () => {
    const eventId = await event(`Board Night ${testId("t")}`)
    const [me, author] = [await person("ctx-board-me"), await person("ctx-board-author", "Arjun Rao")]
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: author, kind: "offer", body: "Two seats", spaces_left: 2 }, select: { id: true } })
    // The viewer can see the board: they are going.
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: me, status: "going" } })

    const res = await postBlock.POST(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/board/${post.id}/block`, { method: "POST", headers: { authorization: `Bearer ${await tokenOf(me)}` } }),
      { params: Promise.resolve({ eventId, postId: post.id }) }
    )
    expect(res.status).toBe(200)

    const row = await db.blocked_users.findFirstOrThrow({ where: { blocker_id: me, blocked_id: author } })
    expect(row.seen_as).toEqual(expect.any(String))
    expect(row.seen_as).not.toContain("Arjun")
    expect(row.seen_in).toMatch(/^Board Night /)
  })

  it("a block by a raw id records nothing, and an older row with no context reads null", async () => {
    const [me, them, old] = [await person("ctx-raw-me"), await person("ctx-raw-them"), await person("ctx-raw-old")]
    await block(me, them)
    await db.blocked_users.create({ data: { blocker_id: me, blocked_id: old } })
    const { body } = await list(me)
    expect(body.users).toHaveLength(2)
    for (const u of body.users) expect(u).toMatchObject({ seen_as: null, seen_in: null })
  })

  it("leaving a match with a block keeps their match pseudonym and the room it came from", async () => {
    const eventId = await event(`Jazz Night ${testId("t")}`)
    const [me, them] = [await person("ctx-dm-me"), await person("ctx-dm-them", "Meera Iyer")]
    const [user1_id, user2_id] = conversationPair(me, them)
    const theirs = `Amber Heron ${randomUUID().slice(0, 6)}`
    const conversation = await db.private_conversations.create({
      data: {
        user1_id,
        user2_id,
        origin_event_id: eventId,
        user1_pseudonym: user1_id === them ? theirs : "Mine",
        user2_pseudonym: user2_id === them ? theirs : "Mine",
      },
      select: { id: true },
    })
    await db.$transaction((tx) => leaveConversationIn(tx, { conversationId: conversation.id, userId: me, otherId: them, action: "block" }))

    const row = await db.blocked_users.findFirstOrThrow({ where: { blocker_id: me, blocked_id: them } })
    expect(row).toMatchObject({ seen_as: theirs })
    expect(row.seen_in).toMatch(/^Jazz Night /)
  })

  it("a block by a conversation's handle keeps the same", async () => {
    const [me, them] = [await person("ctx-dmh-me"), await person("ctx-dmh-them")]
    const [user1_id, user2_id] = conversationPair(me, them)
    const theirs = `Quiet Lynx ${randomUUID().slice(0, 6)}`
    const conversation = await db.private_conversations.create({
      data: { user1_id, user2_id, user1_pseudonym: user1_id === them ? theirs : "Mine", user2_pseudonym: user2_id === them ? theirs : "Mine" },
      select: { id: true },
    })
    await block(me, roomHandle({ kind: "dm", groupId: conversation.id }, them))
    expect(await db.blocked_users.findFirstOrThrow({ where: { blocker_id: me, blocked_id: them } })).toMatchObject({ seen_as: theirs, seen_in: null })
  })

  it("blocking a message request keeps where you met, and no pseudonym", async () => {
    const eventId = await event(`Startup Breakfast ${testId("t")}`)
    const [me, sender] = [await person("ctx-req-me"), await person("ctx-req-sender")]
    const request = await db.message_requests.create({ data: { sender_id: sender, recipient_id: me, met_in_event_id: eventId }, select: { id: true } })
    const res = await respondRoute.POST(
      new NextRequest(`http://localhost/api/mobile/message-requests/${request.id}/respond`, {
        method: "POST",
        headers: { authorization: `Bearer ${await tokenOf(me)}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "block" }),
      }),
      { params: Promise.resolve({ requestId: request.id }) }
    )
    expect(res.status).toBe(200)
    const row = await db.blocked_users.findFirstOrThrow({ where: { blocker_id: me, blocked_id: sender } })
    expect(row.seen_as).toBeNull()
    expect(row.seen_in).toMatch(/^Startup Breakfast /)
  })

  it("an existing block keeps what it first recorded", async () => {
    const eventId = await event(`First Place ${testId("t")}`)
    const [me, them] = [await person("ctx-keep-me"), await person("ctx-keep-them")]
    await db.blocked_users.create({ data: { blocker_id: me, blocked_id: them, seen_as: "Original", seen_in: "Original place" } })
    await block(me, roomHandle(eventId, them))
    expect(await db.blocked_users.findFirstOrThrow({ where: { blocker_id: me, blocked_id: them } })).toMatchObject({ seen_as: "Original", seen_in: "Original place" })
  })
})

describe("the list", () => {
  it("says a deleted account was deleted", async () => {
    const [me, gone] = [await person("ctx-del-me"), await person("ctx-del-gone")]
    await db.blocked_users.create({ data: { blocker_id: me, blocked_id: gone, seen_as: "Pale Moth" } })
    await db.user.update({ where: { id: gone }, data: { deletedAt: new Date(), name: null } })
    const { body } = await list(me)
    expect(body.users).toEqual([expect.objectContaining({ account_deleted: true, seen_as: "Pale Moth", blocked_user_name: null })])
  })

  it("falls back to a match's pseudonym for an older row", async () => {
    const [me, them] = [await person("ctx-fb-me"), await person("ctx-fb-them")]
    const [user1_id, user2_id] = conversationPair(me, them)
    await db.private_conversations.create({
      data: { user1_id, user2_id, user1_pseudonym: user1_id === them ? "Sleepy Fox" : "Mine", user2_pseudonym: user2_id === them ? "Sleepy Fox" : "Mine" },
    })
    await db.blocked_users.create({ data: { blocker_id: me, blocked_id: them } })
    const { body } = await list(me)
    expect(body.users[0]).toMatchObject({ blocked_user_name: "Sleepy Fox", seen_as: "Sleepy Fox", seen_in: null })
  })
})

describe("?q= — a search on the server", () => {
  let me: string
  let hidden: string
  let named: string

  beforeAll(async () => {
    me = await person("ctx-q-me")
    hidden = await person("ctx-q-hidden", "Zanele Okafor")
    named = await person("ctx-q-named", "Zanele Named")
    const [others] = [await Promise.all(Array.from({ length: 6 }, (_, i) => person(`ctx-q-o${i}`)))]
    await db.blocked_users.createMany({
      data: [
        { blocker_id: me, blocked_id: hidden, seen_as: "Cosmic Panda", seen_in: "Rooftop Mixer" },
        ...others.map((id, i) => ({ blocker_id: me, blocked_id: id, seen_as: `Neon Gecko ${i}`, seen_in: i % 2 ? "Saint-Jean-sur-Richelieu Social" : "Tech Week" })),
      ],
    })
    // A conversation with no pseudonyms: an accepted request, which showed the real name.
    const [user1_id, user2_id] = conversationPair(me, named)
    await db.private_conversations.create({ data: { user1_id, user2_id } })
    await db.blocked_users.create({ data: { blocker_id: me, blocked_id: named } })
  })

  it("finds by the pseudonym and by the place, case-insensitively, with the total of the matches", async () => {
    const byName = await list(me, "?q=cosmic")
    expect(byName.body.users.map((u) => u.seen_as)).toEqual(["Cosmic Panda"])
    expect(byName.body.pagination.totalCount).toBe(1)

    const byPlace = await list(me, "?q=richelieu")
    expect(byPlace.body.users).toHaveLength(3)
    expect(byPlace.body.pagination.totalCount).toBe(3)
  })

  it("never finds anybody by a real name the list may not show", async () => {
    const res = await list(me, "?q=okafor")
    expect(res.body.users).toEqual([])
    expect(res.body.pagination.totalCount).toBe(0)
  })

  it("finds by a real name the list does show (an accepted request named them)", async () => {
    const res = await list(me, "?q=zanele")
    expect(res.body.users.map((u) => u.blocked_user_name)).toEqual(["Zanele Named"])
  })

  it("treats % and _ as letters", async () => {
    expect((await list(me, `?q=${encodeURIComponent("%")}`)).body.users).toEqual([])
    expect((await list(me, `?q=${encodeURIComponent("_")}`)).body.users).toEqual([])
  })

  it("pages a search with its own cursor, and the whole list without one keeps its total", async () => {
    const first = await list(me, "?q=gecko&limit=4")
    expect(first.body.users).toHaveLength(4)
    expect(first.body.pagination).toMatchObject({ hasMore: true, totalCount: 6 })
    const second = await list(me, `?q=gecko&limit=4&cursor=${first.body.pagination.nextCursor}`)
    expect(second.body.users).toHaveLength(2)
    expect(new Set([...first.body.users, ...second.body.users].map((u) => u.blocked_id)).size).toBe(6)

    expect((await list(me)).body.pagination.totalCount).toBe(8)
  })

  it("refuses a search longer than 100 characters, and a blank one is no search", async () => {
    expect((await list(me, `?q=${"a".repeat(101)}`)).status).toBe(400)
    expect((await list(me, "?q=%20%20")).body.pagination.totalCount).toBe(8)
  })
})
