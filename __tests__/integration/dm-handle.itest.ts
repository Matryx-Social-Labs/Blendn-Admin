import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { emitPrivateTyping, emitReads } from "@/lib/socket-server"

import { cleanup, closeDb, db, makeUser, onboard } from "./helpers"

/**
 * The other side of a pseudonymous match is a conversation handle, not an
 * account id, until THEY reveal to you (SCRUM-752 follow-up).
 *
 * The probe: a friend (`friends_see_me_in_rooms` off) who also matched you as
 * "Otter". The inbox sent their raw id beside the pseudonym, and the friends
 * list, a message request, a friend request or a crew all carry that raw id with
 * a name — one client-side join and the pseudonym was gone. The id is the join
 * key, so the id is what the conversation no longer sends.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const inboxRoute = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")
const detailRoute = require("@/app/api/mobile/conversations/[conversationId]/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/route")
const messagesRoute = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")
const blockRoute = require("@/app/api/mobile/users/[userId]/block/route") as typeof import("@/app/api/mobile/users/[userId]/block/route")
const reportRoute = require("@/app/api/mobile/users/[userId]/report/route") as typeof import("@/app/api/mobile/users/[userId]/report/route")
const requestsRoute = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const friendRoute = require("@/app/api/mobile/friends/[userId]/route") as typeof import("@/app/api/mobile/friends/[userId]/route")
const friendDmRoute = require("@/app/api/mobile/friends/[userId]/conversation/route") as typeof import("@/app/api/mobile/friends/[userId]/conversation/route")
const friendsRoute = require("@/app/api/mobile/friends/route") as typeof import("@/app/api/mobile/friends/route")
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}

const users: string[] = []

async function person(label: string, name: string): Promise<Person> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name, photos: [`https://img.invalid/${label}.jpg`], blur_photo: `https://img.invalid/${label}.blur.jpg` } })
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

const inbox = async (as: Person) => (await call(inboxRoute.GET as Handler, "/api/mobile/conversations", as)).body
const detail = (as: Person, id: string) => call(detailRoute.GET as Handler, `/api/mobile/conversations/${id}`, as, { params: { conversationId: id } })
const thread = (as: Person, id: string) => call(messagesRoute.GET as Handler, `/api/mobile/conversations/${id}/messages`, as, { params: { conversationId: id } })
const send = (as: Person, id: string, text: string) =>
  call(messagesRoute.POST as Handler, `/api/mobile/conversations/${id}/messages`, as, { method: "POST", body: { text }, params: { conversationId: id } })
const viaId = (handler: Handler, base: string, as: Person, userId: string, method = "GET", body?: unknown) =>
  call(handler, `${base}/${userId}`, as, { method, params: { userId }, ...(body !== undefined && { body }) })

/** Ana and Ben: friends, and matched as Otter and Heron, Ben not revealed to Ana. */
async function friendsWhoMatched(label: string, opts: { benRevealed?: boolean } = {}) {
  const [ana, ben] = [await person(`${label}-a`, "Ana"), await person(`${label}-b`, "Benedict Cumberbatch")]
  const [user1_id, user2_id] = conversationPair(ana.id, ben.id)
  await db.friendships.create({ data: { user1_id, user2_id } })
  const benIs1 = user1_id === ben.id
  const conv = await db.private_conversations.create({
    data: {
      user1_id,
      user2_id,
      user1_pseudonym: benIs1 ? "Heron" : "Otter",
      user2_pseudonym: benIs1 ? "Otter" : "Heron",
      // Ana has revealed to Ben; Ben has not revealed to Ana.
      user1_revealed: benIs1 ? !!opts.benRevealed : true,
      user2_revealed: benIs1 ? true : !!opts.benRevealed,
    },
  })
  return { ana, ben, id: conv.id }
}

type Emit = { rooms: string[]; event: string; payload: any } // eslint-disable-line @typescript-eslint/no-explicit-any
let emits: Emit[] = []
const shared = globalThis as { __blendnSocketIo?: unknown }
const fakeIo = () => {
  const chain = (rooms: string[]): { to: (r: string) => unknown; emit: (event: string, payload: unknown) => void } => ({
    to: (r) => chain([...rooms, r]),
    emit: (event, payload) => void emits.push({ rooms, event, payload }),
  })
  return { to: (r: string) => chain([r]), in: () => ({ socketsLeave: () => undefined, fetchSockets: async () => [] }) }
}
beforeEach(() => {
  emits = []
  shared.__blendnSocketIo = fakeIo()
})
afterEach(() => {
  shared.__blendnSocketIo = undefined
})

afterAll(async () => {
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, [])
  await closeDb()
})

describe("a friend who is also an unrevealed match is a handle in the DM", () => {
  it("sends no account id on the inbox, the detail, the thread or the create call, and the same handle on all of them", async () => {
    const { ana, ben, id } = await friendsWhoMatched("dmh-1")
    await send(ben, id, "hello from Heron")
    await send(ana, id, "hello from Otter")

    const list = await inbox(ana)
    const row = list.data.conversations.find((c: { id: string }) => c.id === id)
    const handle = row.otherUser.id as string
    expect(handle).toMatch(/^rh_/)
    expect(row.lastMessage.senderId).toBe(ana.id) // the last message is Ana's own: her real id
    expect(JSON.stringify(list)).not.toContain(ben.id)

    const d = await detail(ana, id)
    expect(d.body.data.otherUser.id).toBe(handle)
    expect(JSON.stringify(d.body)).not.toContain(ben.id)

    const t = await thread(ana, id)
    const msgs = t.body.data.messages as { senderId: string; sender: { id: string }; text: string }[]
    const theirs = msgs.find((m) => m.text === "hello from Heron")!
    const mine = msgs.find((m) => m.text === "hello from Otter")!
    // Both the same handle the inbox gave, so the app still tells whose bubble it is; mine stay my id.
    expect([theirs.senderId, theirs.sender.id]).toEqual([handle, handle])
    expect([mine.senderId, mine.sender.id]).toEqual([ana.id, ana.id])
    expect(JSON.stringify(t.body)).not.toContain(ben.id)

    // A handle-scoped payload never carries the stored blur: one URL for every room, so it would link pseudonyms across them.
    for (const wire of [JSON.stringify(list), JSON.stringify(d.body), JSON.stringify(t.body)]) {
      expect(wire).not.toContain("blur")
    }

    // And Ben, who Ana has revealed to, sees Ana's real id: she is a name to him.
    const bens = (await inbox(ben)).data.conversations.find((c: { id: string }) => c.id === id)
    expect(bens.otherUser.id).toBe(ana.id)

    // The handle opens nothing that names Ben.
    const friendsList = (await call(friendsRoute.GET as Handler, "/api/mobile/friends", ana)).body
    expect(friendsList.data.friends[0].userId).toBe(ben.id) // the friends list is where the raw id lives
    expect(handle).not.toBe(ben.id)
  })

  it("is accepted by block, report and the conversation lookup, and the block ends the friendship", async () => {
    const { ana, ben, id } = await friendsWhoMatched("dmh-2")
    const handle = (await inbox(ana)).data.conversations.find((c: { id: string }) => c.id === id).otherUser.id as string

    const report = await call(reportRoute.POST as Handler, `/api/mobile/users/${handle}/report`, ana, {
      method: "POST",
      body: { reason: "spam" },
      params: { userId: handle },
    })
    expect(report.status).toBe(201)
    expect(await db.user_reports.count({ where: { reporter_id: ana.id, reported_id: ben.id } })).toBeGreaterThanOrEqual(1)

    const again = await call(inboxRoute.POST as Handler, "/api/mobile/conversations", ana, { method: "POST", body: { otherUserId: handle } })
    expect(again.body.data.id).toBe(id)
    expect(again.body.data.otherUser.id).toBe(handle)

    const blocked = await call(blockRoute.POST as Handler, `/api/mobile/users/${handle}/block`, ana, { method: "POST", params: { userId: handle } })
    expect(blocked.status).toBeLessThan(300)
    expect(await db.blocked_users.count({ where: { blocker_id: ana.id, blocked_id: ben.id } })).toBe(1)
    expect(await db.friendships.count({ where: { OR: [{ user1_id: ana.id }, { user2_id: ana.id }] } })).toBe(0)
  })

  it("names nobody on the friend, profile and friend-request doors: each answers as an id nobody has", async () => {
    const { ana, id } = await friendsWhoMatched("dmh-3")
    const handle = (await inbox(ana)).data.conversations.find((c: { id: string }) => c.id === id).otherUser.id as string
    const nobody = "no-such-user"
    const same = async (handler: Handler, base: string) => {
      const [h, n] = [await viaId(handler, base, ana, handle), await viaId(handler, base, ana, nobody)]
      expect({ status: h.status, body: h.body }).toEqual({ status: n.status, body: n.body })
    }
    await same(friendRoute.GET as Handler, "/api/mobile/friends")
    await same(profileRoute.GET as Handler, "/api/mobile/profiles")
    const dm = await viaId(friendDmRoute.POST as Handler, "/api/mobile/friends", ana, `${handle}`, "POST")
    expect(dm.status).toBe(404)

    const ask = (userId: string) => call(requestsRoute.POST as Handler, "/api/mobile/friends/requests", ana, { method: "POST", body: { userId } })
    expect(await ask(handle)).toEqual(await ask(nobody))
  })

  it("is the raw id again once they reveal, on every surface at once", async () => {
    const { ana, ben, id } = await friendsWhoMatched("dmh-4")
    await send(ben, id, "before")
    expect((await detail(ana, id)).body.data.otherUser.id).toMatch(/^rh_/)

    const [user1_id] = conversationPair(ana.id, ben.id)
    await db.private_conversations.update({ where: { id }, data: user1_id === ben.id ? { user1_revealed: true } : { user2_revealed: true } })

    const row = (await inbox(ana)).data.conversations.find((c: { id: string }) => c.id === id)
    expect(row.otherUser.id).toBe(ben.id)
    expect((await detail(ana, id)).body.data.otherUser.id).toBe(ben.id)
    const m = (await thread(ana, id)).body.data.messages[0]
    expect([m.senderId, m.sender.id]).toEqual([ben.id, ben.id])
  })
})

describe("the DM socket events carry the handle too", () => {
  it("a message: the recipient's copy names the sender by the handle, the sender's own devices by their id, never the conversation room", async () => {
    const { ana, ben, id } = await friendsWhoMatched("dmh-5")
    const handleForAna = (await inbox(ana)).data.conversations.find((c: { id: string }) => c.id === id).otherUser.id as string
    expect(handleForAna).toMatch(/^rh_/)

    emits = []
    await send(ben, id, "typed by Heron") // Ben, unrevealed to Ana, writes to Ana
    const message = emits.filter((e) => e.event === "private:message")
    const toAna = message.find((e) => e.rooms.includes(`user:${ana.id}`))!
    const toBen = message.find((e) => e.rooms.includes(`user:${ben.id}`))!
    expect(toAna.payload.message.senderId).toBe(handleForAna)
    expect(toAna.payload.message.sender.id).toBe(handleForAna)
    expect(toBen.payload.message.senderId).toBe(ben.id)
    expect(JSON.stringify(toAna.payload)).not.toContain(ben.id)
    expect(JSON.stringify(emits)).not.toContain("blur")
    expect(toAna.rooms).not.toContain(`conversation:${id}`)
    expect(toBen.rooms).not.toContain(`user:${ana.id}`)
  })

  it("typing and read receipts: to the other person alone, by the handle, until they reveal", async () => {
    const { ana, ben, id } = await friendsWhoMatched("dmh-6")
    const handleForAna = (await inbox(ana)).data.conversations.find((c: { id: string }) => c.id === id).otherUser.id as string

    const benSocket = { data: { userId: ben.id }, to: () => ({ emit: () => undefined }), nsp: fakeIo() }
    emits = []
    await emitPrivateTyping(benSocket as never, id, true)
    const typing = emits.find((e) => e.event === "private:typing")!
    expect(typing.rooms).toEqual([`user:${ana.id}`])
    expect(typing.payload.userId).toBe(handleForAna)
    expect(JSON.stringify(typing.payload)).not.toContain(ben.id)

    emits = []
    emitReads(ben.id, [[id, ["m1"]]])
    for (let i = 0; i < 40 && !emits.length; i++) await new Promise((r) => setTimeout(r, 50))
    const read = emits.find((e) => e.event === "private:read")!
    expect(read.rooms).toEqual([`user:${ana.id}`])
    expect(read.payload.readBy).toBe(handleForAna)

    // Ana is revealed to Ben, so for Ben she is a name: her typing keeps the old shape.
    const anaSocket = { data: { userId: ana.id }, to: (room: string) => ({ emit: (event: string, payload: unknown) => void emits.push({ rooms: [room], event, payload }) }), nsp: fakeIo() }
    emits = []
    await emitPrivateTyping(anaSocket as never, id, true)
    const anas = emits.find((e) => e.event === "private:typing")!
    expect(anas.rooms).toEqual([`conversation:${id}`])
    expect(anas.payload.userId).toBe(ana.id)
  })
})
