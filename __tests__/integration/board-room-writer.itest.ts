jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { NextRequest } from "next/server"

import { conversationPair } from "@/lib/conversations"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"
import { socketHarness, until } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const decide = require("@/app/api/mobile/board/requests/[requestId]/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/route")
const participantsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route")
const messagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * The board post's room is written by the product (step 10, CR-I16, the open
 * half of SCRUM-535): the accept that brings a post its second asker makes the
 * room and seats the author and every accepted asker; each later accept seats
 * its asker; a row somebody left is not put back; two accepts at once make one
 * room. The door is still the post (chat-kinds.itest.ts) — these are the rows
 * the socket, the roster and the pseudonyms read.
 */

type Person = { id: string; token: string }
const users: string[] = []
const events: string[] = []
let eventId = ""

const sockets = socketHarness()
beforeAll(() => sockets.start())

afterAll(async () => {
  await sockets.stop()
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

beforeAll(async () => {
  const host = await makeUser(testId("brw-host"), "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
  const start = new Date(Date.now() + 24 * 3600_000)
  await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3600_000) } })
})

async function person(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function offer(author: Person, spaces: number | null = 4) {
  return (
    await db.board_posts.create({
      data: { event_id: eventId, author_id: author.id, kind: "offer", body: `Car from Indiranagar ${testId("p")}`, spaces_left: spaces },
      select: { id: true },
    })
  ).id
}

const ask = async (asker: Person, author: Person, postId: string) =>
  (
    await db.board_requests.create({
      data: { event_id: eventId, post_id: postId, from_user_id: asker.id, to_user_id: author.id, status: "pending" },
      select: { id: true },
    })
  ).id

const accept = (author: Person, requestId: string) =>
  decide.PATCH(
    new NextRequest(`http://localhost/api/mobile/board/requests/${requestId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${author.token}` },
      body: JSON.stringify({ action: "accept" }),
    }),
    { params: Promise.resolve({ requestId }) }
  )

const roomOf = (postId: string) =>
  db.chat_groups.findUnique({
    where: { board_post_id: postId },
    select: { id: true, kind: true, event_id: true, members: { select: { user_id: true, status: true, anonymous_name: true } } },
  })

describe("the board post's room (CR-I16)", () => {
  it("opens on the second accepted asker, with the author and both askers seated", async () => {
    const author = await person("brw-author")
    const [a1, a2, a3] = await Promise.all([person("brw-a1"), person("brw-a2"), person("brw-a3")])
    const post = await offer(author)
    const [r1, r2, r3] = [await ask(a1, author, post), await ask(a2, author, post), await ask(a3, author, post)]

    expect((await accept(author, r1)).status).toBe(200)
    // One asker: their conversation is the room. No group yet.
    expect(await roomOf(post)).toBeNull()

    expect((await accept(author, r2)).status).toBe(200)
    const room = await roomOf(post)
    expect(room).toMatchObject({ kind: "board_post", event_id: null })
    expect(room!.members.map((m) => [m.user_id, m.status]).sort()).toEqual(
      [author.id, a1.id, a2.id].map((id) => [id, "active"]).sort()
    )
    const names = room!.members.map((m) => m.anonymous_name)
    expect(names.every((n) => typeof n === "string" && n.length > 0)).toBe(true)
    expect(new Set(names).size).toBe(names.length)

    // a1 leaves the room; the next accept seats a3 and does not put a1 back.
    await db.chat_group_members.updateMany({ where: { chat_group_id: room!.id, user_id: a1.id }, data: { status: "left", left_at: new Date() } })
    expect((await accept(author, r3)).status).toBe(200)
    const after = await roomOf(post)
    expect(after!.id).toBe(room!.id)
    expect(Object.fromEntries(after!.members.map((m) => [m.user_id, m.status]))).toEqual({
      [author.id]: "active",
      [a1.id]: "left",
      [a2.id]: "active",
      [a3.id]: "active",
    })
  })

  it("two accepts at once make one room, everybody seated once", async () => {
    const author = await person("brw-race-author")
    const [a1, a2, a3] = await Promise.all([person("brw-r1"), person("brw-r2"), person("brw-r3")])
    // No seat count: nothing else on the post's row queues the two accepts.
    const post = await offer(author, null)
    const r1 = await ask(a1, author, post)
    expect((await accept(author, r1)).status).toBe(200)
    const [r2, r3] = [await ask(a2, author, post), await ask(a3, author, post)]

    const answers = await Promise.all([accept(author, r2), accept(author, r3)])
    expect(answers.map((a) => a.status)).toEqual([200, 200])
    expect(await db.chat_groups.count({ where: { board_post_id: post } })).toBe(1)
    const room = await roomOf(post)
    expect(room!.members.map((m) => m.user_id).sort()).toEqual([author.id, a1.id, a2.id, a3.id].sort())
  })

  it("a refused accept seats nobody", async () => {
    const author = await person("brw-full-author")
    const [a1, a2] = await Promise.all([person("brw-f1"), person("brw-f2")])
    const post = await offer(author, 1)
    const [r1, r2] = [await ask(a1, author, post), await ask(a2, author, post)]
    expect((await accept(author, r1)).status).toBe(200)
    // The offer is full: the second accept is refused, and no room comes of it.
    expect((await accept(author, r2)).status).toBe(409)
    expect(await roomOf(post)).toBeNull()
  })
})

/** Two people who closed a conversation: an unmatch, permanent. */
async function unmatched(a: Person, b: Person) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  await db.private_conversations.upsert({
    where: { user1_id_user2_id: { user1_id, user2_id } },
    create: { user1_id, user2_id, closed_at: new Date() },
    update: { closed_at: new Date() },
  })
}

const seatedIn = async (postId: string) =>
  ((await roomOf(postId))?.members.map((m) => m.user_id) ?? []).sort()

describe("nobody is seated beside somebody they are kept apart from (step 10 review H2)", () => {
  it("a blocked pair: the later asker is accepted 1:1 and silently not seated", async () => {
    const author = await person("brw-h2-author")
    const [a1, a2, a3] = await Promise.all([person("brw-h2-a1"), person("brw-h2-a2"), person("brw-h2-a3")])
    await db.blocked_users.create({ data: { blocker_id: a2.id, blocked_id: a1.id } })
    const post = await offer(author)
    const [r1, r2, r3] = [await ask(a1, author, post), await ask(a2, author, post), await ask(a3, author, post)]

    expect((await accept(author, r1)).status).toBe(200)
    const second = await accept(author, r2)
    // Accepted, its conversation open — no error, no hint.
    expect(second.status).toBe(200)
    expect((await second.json()).data.conversationId).toBeTruthy()
    // a2 could not sit beside a1, so there is no group of three yet.
    expect(await roomOf(post)).toBeNull()

    expect((await accept(author, r3)).status).toBe(200)
    expect(await seatedIn(post)).toEqual([author.id, a1.id, a3.id].sort())
  })

  it("a closed conversation keeps the pair apart too", async () => {
    const author = await person("brw-cp-author")
    const [a1, a2, a3] = await Promise.all([person("brw-cp-a1"), person("brw-cp-a2"), person("brw-cp-a3")])
    await unmatched(a1, a3)
    const post = await offer(author)
    for (const a of [a1, a2, a3]) expect((await accept(author, await ask(a, author, post))).status).toBe(200)
    expect(await seatedIn(post)).toEqual([author.id, a1.id, a2.id].sort())
  })

  it("a suspended or erased asker is not seated (L1)", async () => {
    const author = await person("brw-l1-author")
    const [a1, a2, a3] = await Promise.all([person("brw-l1-a1"), person("brw-l1-a2"), person("brw-l1-a3")])
    const post = await offer(author)
    const r1 = await ask(a1, author, post)
    expect((await accept(author, r1)).status).toBe(200)
    await db.user.update({ where: { id: a1.id }, data: { suspended_at: new Date() } })
    for (const a of [a2, a3]) expect((await accept(author, await ask(a, author, post))).status).toBe(200)
    expect(await seatedIn(post)).toEqual([author.id, a2.id, a3.id].sort())
  })

  it("an unmatch after seating hides the pair from each other's roster and history", async () => {
    const author = await person("brw-after-author")
    const [a1, a2] = await Promise.all([person("brw-after-a1"), person("brw-after-a2")])
    const post = await offer(author)
    for (const a of [a1, a2]) expect((await accept(author, await ask(a, author, post))).status).toBe(200)
    const room = (await roomOf(post))!
    await db.chat_messages.create({ data: { chat_group_id: room.id, user_id: a2.id, content: "see you at 7" } })
    await unmatched(a1, a2)

    const as = (who: Person, handler: unknown, path: string) =>
      (handler as (r: NextRequest, c: { params: Promise<unknown> }) => Promise<Response>)(
        new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${who.token}` } }),
        { params: Promise.resolve({ chatGroupId: room.id }) }
      ).then((r) => r.json())
    const roster = await as(a1, participantsRoute.GET, `/api/mobile/chat/groups/${room.id}/participants`)
    expect(roster.data.participants).toHaveLength(2) // the author and a1, not a2
    const history = await as(a1, messagesRoute.GET, `/api/mobile/chat/groups/${room.id}/messages`)
    expect(JSON.stringify(history.data)).not.toContain("see you at 7")
    // The author still sees both.
    const authors = await as(author, participantsRoute.GET, `/api/mobile/chat/groups/${room.id}/participants`)
    expect(authors.data.participants).toHaveLength(3)
  })

  it("an unmatch after seating stops delivery between the pair, live", async () => {
    const author = await person("brw-live-author")
    const [a1, a2] = await Promise.all([person("brw-live-a1"), person("brw-live-a2")])
    const post = await offer(author)
    for (const a of [a1, a2]) expect((await accept(author, await ask(a, author, post))).status).toBe(200)
    const room = (await roomOf(post))!
    const [hearsA1, hearsAuthor] = [await sockets.online(a1), await sockets.online(author)]
    expect(await sockets.joins(hearsA1, room.id)).toBe(true)
    expect(await sockets.joins(hearsAuthor, room.id)).toBe(true)
    await unmatched(a1, a2)

    const send = await messagesRoute.POST(
      new NextRequest(`http://localhost/api/mobile/chat/groups/${room.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a2.token}` },
        body: JSON.stringify({ content: "leaving at 7" }),
      }),
      { params: Promise.resolve({ chatGroupId: room.id }) }
    )
    expect(send.status).toBe(201)
    expect(await until(() => hearsAuthor.heard.message.some((m) => m.message.content === "leaving at 7"))).toBe(true)
    expect(hearsA1.heard.message.some((m) => m.message.content === "leaving at 7")).toBe(false)
  })
})
