import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { revealConversationsFrom } from "@/lib/matches"

import { cleanup, closeDb, db, makeEvent, makeUser, onboard } from "./helpers"

/**
 * A reveal reaches the other person's open DM over the socket (`private:revealed`).
 *
 * The push alone never lands on a simulator and says nothing to a screen that is
 * already open. The event is told to the OTHER participant's `user:{id}` room
 * only, carries the conversation id and nothing else, and goes to both once the
 * pair is mutual (the moment the friend offer opens). A closed pair (an unmatch
 * or a block closes it) is told to nobody.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const revealRoute = require("@/app/api/mobile/conversations/[conversationId]/reveal/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/reveal/route")
const blockRoute = require("@/app/api/mobile/users/[userId]/block/route") as typeof import("@/app/api/mobile/users/[userId]/block/route")
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
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(handler: Handler, path: string, as: Person, params: Record<string, string>, body?: unknown) {
  const res = await handler(
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) as Promise<never> }
  )
  return res.status
}
const reveal = (as: Person, id: string) =>
  call(revealRoute.POST as Handler, `/api/mobile/conversations/${id}/reveal`, as, { conversationId: id })
const block = (as: Person, userId: string) =>
  call(blockRoute.POST as Handler, `/api/mobile/users/${userId}/block`, as, { userId }, {})

async function pair(a: Person, b: Person, o: { origin_event_id?: string; revealed?: { a?: boolean; b?: boolean }; closed?: boolean } = {}) {
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
      ...(o.closed && { closed_at: new Date(), closed_by: a.id, closed_reason: "unmatch" }),
    },
  })
  return row.id
}

// A fake io: the emitters read it from globalThis, as they do in the app.
type Emit = { rooms: string[]; event: string; payload: unknown }
let emits: Emit[] = []
const shared = globalThis as { __blendnSocketIo?: unknown }
beforeEach(() => {
  emits = []
  shared.__blendnSocketIo = {
    to: (rooms: string | string[]) => ({
      emit: (event: string, payload: unknown) => void emits.push({ rooms: [rooms].flat(), event, payload }),
    }),
    in: () => ({ socketsLeave: () => undefined, fetchSockets: async () => [] }),
  }
})
afterEach(() => {
  shared.__blendnSocketIo = undefined
})

const revealedEmits = () => emits.filter((e) => e.event === "private:revealed")
const roomsOf = (...ps: Person[]) => ps.map((p) => `user:${p.id}`).sort()
// The push and the bell row are fire-and-forget; give them time to land before the next test.
const settle = () => new Promise((r) => setTimeout(r, 300))

afterAll(async () => {
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, events)
  await closeDb()
})

describe("private:revealed from the DM reveal route", () => {
  it("goes to the other person's user room only, with the conversation id and nothing else", async () => {
    const [ana, ben, eve] = [await person("rs-1a", "Ana"), await person("rs-1b", "Ben"), await person("rs-1c", "Eve")]
    const id = await pair(ana, ben)

    expect(await reveal(ana, id)).toBe(200)
    await settle()

    expect(revealedEmits()).toEqual([{ rooms: [`user:${ben.id}`], event: "private:revealed", payload: { conversationId: id } }])
    expect(JSON.stringify(revealedEmits())).not.toContain("Ana")
    expect(JSON.stringify(revealedEmits())).not.toContain(eve.id)
  })

  it("goes to both once both have revealed", async () => {
    const [ana, ben] = [await person("rs-2a", "Ana"), await person("rs-2b", "Ben")]
    const id = await pair(ana, ben, { revealed: { a: true } })

    expect(await reveal(ben, id)).toBe(200)
    await settle()

    expect(revealedEmits()).toHaveLength(1)
    expect([...revealedEmits()[0].rooms].sort()).toEqual(roomsOf(ana, ben))
    expect(revealedEmits()[0].payload).toEqual({ conversationId: id })
  })

  it("is told to nobody for a stranger to the conversation", async () => {
    const [ana, ben, eve] = [await person("rs-3a", "Ana"), await person("rs-3b", "Ben"), await person("rs-3c", "Eve")]
    const id = await pair(ana, ben)

    expect(await reveal(eve, id)).toBe(403)
    expect(revealedEmits()).toEqual([])
  })

  it("is told to nobody when the pair is closed", async () => {
    const [ana, ben] = [await person("rs-4a", "Ana"), await person("rs-4b", "Ben")]
    const id = await pair(ana, ben, { closed: true })

    expect(await reveal(ana, id)).toBe(404)
    expect(revealedEmits()).toEqual([])
  })

  it("is told to nobody when one blocked the other (a block closes the conversation)", async () => {
    const [ana, ben] = [await person("rs-5a", "Ana"), await person("rs-5b", "Ben")]
    const id = await pair(ana, ben)
    expect(await block(ben, ana.id)).toBe(200)
    emits = []

    expect(await reveal(ana, id)).toBe(404)
    expect(revealedEmits()).toEqual([])
  })
})

describe("private:revealed from a reveal in the room carrying into DMs", () => {
  async function room() {
    const host = await makeUser("rs-host", "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    return eventId
  }

  it("tells the other person of each DM the revealer's reveal moved, and no one else", async () => {
    const [ana, ben, cat, dan] = [await person("rs-6a", "Ana"), await person("rs-6b", "Ben"), await person("rs-6c", "Cat"), await person("rs-6d", "Dan")]
    const eventId = await room()
    const withBen = await pair(ana, ben, { origin_event_id: eventId })
    const withCat = await pair(ana, cat, { origin_event_id: eventId })
    await pair(ben, dan, { origin_event_id: eventId }) // not Ana's

    await revealConversationsFrom(eventId, [ana.id])

    const byConversation = new Map(revealedEmits().map((e) => [(e.payload as { conversationId: string }).conversationId, e.rooms]))
    expect(byConversation.size).toBe(2)
    expect(byConversation.get(withBen)).toEqual([`user:${ben.id}`])
    expect(byConversation.get(withCat)).toEqual([`user:${cat.id}`])
  })

  it("tells both when the carry makes the pair mutual", async () => {
    const [ana, ben] = [await person("rs-7a", "Ana"), await person("rs-7b", "Ben")]
    const eventId = await room()
    const id = await pair(ana, ben, { origin_event_id: eventId, revealed: { b: true } })

    await revealConversationsFrom(eventId, [ana.id])

    expect(revealedEmits()).toHaveLength(1)
    expect([...revealedEmits()[0].rooms].sort()).toEqual(roomsOf(ana, ben))
    expect(revealedEmits()[0].payload).toEqual({ conversationId: id })
  })

  it("says nothing for a side already revealed or a closed pair", async () => {
    const [ana, ben, cat] = [await person("rs-8a", "Ana"), await person("rs-8b", "Ben"), await person("rs-8c", "Cat")]
    const eventId = await room()
    await pair(ana, ben, { origin_event_id: eventId, revealed: { a: true } })
    await pair(ana, cat, { origin_event_id: eventId, closed: true })

    await revealConversationsFrom(eventId, [ana.id])

    expect(revealedEmits()).toEqual([])
  })
})
