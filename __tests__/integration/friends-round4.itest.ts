import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"

import { cleanup, closeDb, db, makeUser, onboard } from "./helpers"

/**
 * Flow 7's server half (SCRUM-1093), through the real handlers on a migrated database:
 *
 * - `GET /friends/requests` says where each incoming ask came from (`via`: link, match, or null from before), and the
 *   column's CHECK refuses anything else;
 * - `GET /friends?order=name` pages A–Z under the app's letter rule with every letter's count, jumps with `from`, and
 *   never lists a deleted friend; the default order is unchanged.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const invite = require("@/app/api/mobile/friends/invite/route") as typeof import("@/app/api/mobile/friends/invite/route")
const requests = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const requestById = require("@/app/api/mobile/friends/requests/[requestId]/route") as typeof import("@/app/api/mobile/friends/requests/[requestId]/route")
const friendsRoute = require("@/app/api/mobile/friends/route") as typeof import("@/app/api/mobile/friends/route")
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

const linkOf = async (p: Person) => (await call(invite.GET as Handler, "/api/mobile/friends/invite", p)).body.data.token as string
const ask = (as: Person, body: { token: string } | { userId: string }) =>
  call(requests.POST as Handler, "/api/mobile/friends/requests", as, { method: "POST", body })
const incoming = async (as: Person) =>
  (await call(requests.GET as Handler, "/api/mobile/friends/requests", as)).body.data.incoming as {
    id: string
    person: { userId: string }
    via: string | null
  }[]
const withdraw = (as: Person, requestId: string) =>
  call(requestById.DELETE as Handler, `/api/mobile/friends/requests/${requestId}`, as, { method: "DELETE", params: { requestId } })
const list = (as: Person, query = "") => call(friendsRoute.GET as Handler, `/api/mobile/friends${query}`, as)

/** A match both revealed in: the one relationship a request by user id is allowed for. */
async function revealedMatch(a: Person, b: Person) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  await db.private_conversations.create({
    data: { user1_id, user2_id, user1_pseudonym: "Otter", user2_pseudonym: "Heron", user1_revealed: true, user2_revealed: true },
  })
}

async function befriend(a: Person, b: Person) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  await db.friendships.create({ data: { user1_id, user2_id } })
}

afterAll(async () => {
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.friend_invites.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

describe("GET /friends/requests: where each ask came from", () => {
  it("says link for an invite link, match for a revealed match, and null for a request from before", async () => {
    const me = await person("r4-me", "Mira")
    const [byLink, byMatch, old] = [await person("r4-link", "Lina"), await person("r4-match", "Mateo"), await person("r4-old", "Olga")]

    expect((await ask(byLink, { token: await linkOf(me) })).body.data).toEqual({ state: "requested" })
    await revealedMatch(byMatch, me)
    expect((await ask(byMatch, { userId: me.id })).body.data).toEqual({ state: "requested" })
    // As every row written before the column existed reads.
    await db.friend_requests.create({ data: { sender_id: old.id, recipient_id: me.id } })

    const via = new Map((await incoming(me)).map((r) => [r.person.userId, r.via]))
    expect(via.get(byLink.id)).toBe("link")
    expect(via.get(byMatch.id)).toBe("match")
    expect(via.get(old.id)).toBeNull()
  })

  it("takes the new source when a withdrawn request is asked again another way", async () => {
    const me = await person("r4-me2", "Mira")
    const them = await person("r4-again", "Tomas")
    await ask(them, { token: await linkOf(me) })
    const [first] = await incoming(me)
    expect(first.via).toBe("link")

    expect((await withdraw(them, first.id)).status).toBe(200)
    await revealedMatch(them, me)
    await ask(them, { userId: me.id })
    const [again] = await incoming(me)
    expect(again).toMatchObject({ id: first.id, via: "match" })
  })

  it("refuses any other source at the database (friend_requests_via_known)", async () => {
    const [a, b] = [await person("r4-chk-a", "A"), await person("r4-chk-b", "B")]
    await expect(db.friend_requests.create({ data: { sender_id: a.id, recipient_id: b.id, via: "qr" } })).rejects.toThrow()
  })
})

describe("GET /friends?order=name", () => {
  const NAMES = ["Zoe", "7even", "प्रियंका शर्मा", "ábhi", "Олег", "Marc-André Lefebvre-Desrosiers", "Aarav", "Élodie"]
  let me: Person
  let gone: Person

  beforeAll(async () => {
    me = await person("r4-az", "Asha")
    for (const [i, name] of NAMES.entries()) await befriend(me, await person(`r4-az-${i}`, name))
    gone = await person("r4-az-gone", "Bertha")
    await befriend(me, gone)
    await db.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })
  })

  it("orders A–Z, then other scripts, then #, and counts every letter", async () => {
    const res = await list(me, "?order=name")
    expect(res.status).toBe(200)
    expect((res.body.data.friends as { name: string }[]).map((f) => f.name)).toEqual([
      "Aarav",
      "ábhi",
      "Élodie",
      "Marc-André Lefebvre-Desrosiers",
      "Zoe",
      "Олег",
      "प्रियंका शर्मा",
      "7even",
    ])
    expect(res.body.data.letters).toEqual([
      { letter: "A", count: 2 },
      { letter: "E", count: 1 },
      { letter: "M", count: 1 },
      { letter: "Z", count: 1 },
      { letter: "О", count: 1 },
      { letter: "प", count: 1 },
      { letter: "#", count: 1 },
    ])
    // A deleted friend is nowhere: not a row, not a letter (no B), not in the count.
    expect(res.body.data.count).toBe(NAMES.length)
    expect(res.body.data.pagination).toMatchObject({ totalCount: NAMES.length, hasMore: false, nextCursor: null })
    expect(res.body.data.friends[0]).toEqual({ userId: expect.any(String), name: "Aarav", photo: null, since: expect.any(String) })
  })

  it("pages by its cursor with nothing repeated or skipped", async () => {
    const seen: string[] = []
    let query = "?order=name&limit=3"
    for (let i = 0; i < 5; i++) {
      const res = await list(me, query)
      seen.push(...(res.body.data.friends as { name: string }[]).map((f) => f.name))
      const next = res.body.data.pagination.nextCursor as string | null
      if (!next) break
      query = `?order=name&limit=3&cursor=${encodeURIComponent(next)}`
    }
    expect(seen).toHaveLength(NAMES.length)
    expect(new Set(seen).size).toBe(NAMES.length)
  })

  it("jumps to a letter with from, and to the next letter with names when it has none", async () => {
    const names = async (from: string) =>
      ((await list(me, `?order=name&limit=2&from=${encodeURIComponent(from)}`)).body.data.friends as { name: string }[]).map((f) => f.name)
    expect(await names("m")).toEqual(["Marc-André Lefebvre-Desrosiers", "Zoe"])
    expect(await names("B")).toEqual(["Élodie", "Marc-André Lefebvre-Desrosiers"])
    expect(await names("प")).toEqual(["प्रियंका शर्मा", "7even"])
  })

  it("filters with q, and the letters follow the filter", async () => {
    const res = await list(me, "?order=name&q=ma")
    expect((res.body.data.friends as { name: string }[]).map((f) => f.name)).toEqual(["Marc-André Lefebvre-Desrosiers"])
    expect(res.body.data.letters).toEqual([{ letter: "M", count: 1 }])
  })

  it.each([
    ["?order=alpha", "Invalid order"],
    ["?order=name&from=AB", "Invalid from: one letter or #"],
    ["?order=name&cursor=nope", "Invalid cursor"],
    ["?order=name&from=A&cursor=x", "Use cursor or from, not both"],
  ])("refuses %s", async (query, message) => {
    const res = await list(me, query)
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain(message)
  })

  it("leaves the default order newest first, with no letters", async () => {
    const res = await list(me)
    expect(res.status).toBe(200)
    expect(res.body.data.letters).toBeUndefined()
    expect(res.body.data.friends[0].name).toBe("Élodie")
  })
})
