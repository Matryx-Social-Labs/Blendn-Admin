import { NextRequest } from "next/server"

/*
 * The lists a person accumulates are paged by a cursor and say how many there
 * are in all (SCRUM-760): the inbox, friends, friend requests, blocked people
 * and the board. Each is walked end to end here with more rows than a page,
 * rows sharing a timestamp (a bulk insert) and a first page that is what an
 * installed client, which cannot ask for a second, still shows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const inbox = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")
const friendsRoute = require("@/app/api/mobile/friends/route") as typeof import("@/app/api/mobile/friends/route")
const requestsRoute = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const blockedRoute = require("@/app/api/mobile/users/blocked/route") as typeof import("@/app/api/mobile/users/blocked/route")
const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
let me = { id: "", token: "" }

afterAll(async () => {
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: me.id }, { user2_id: me.id }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: me.id }, { user2_id: me.id }] } })
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: me.id }, { recipient_id: me.id }] } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: me.id }, { blocked_id: me.id }] } })
  await cleanup(users, events)
  await closeDb()
})

/** `n` people, in one statement. */
async function crowd(label: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, (_, i) => testId(`${label}${i}`))
  await db.user.createMany({ data: ids.map((id) => ({ id, email: `${id}@itest.invalid`, name: `P ${id.slice(-6)}`, role: "attendee" as const })) })
  users.push(...ids)
  return ids
}

beforeAll(async () => {
  const id = await makeUser(testId("lp-me"))
  users.push(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  me = { id, token: signAccessToken(id, email) }
})

const get = (route: { GET: (r: NextRequest, c?: never) => Promise<Response> }, path: string, extra: Record<string, string> = {}) => {
  const qs = new URLSearchParams(extra).toString()
  return route.GET(new NextRequest(`http://localhost${path}${qs ? `?${qs}` : ""}`, { headers: { authorization: `Bearer ${me.token}` } }))
}
type Page<T> = { items: T[]; pagination: { limit: number; hasMore: boolean; nextCursor: string | null; totalCount: number } }

/** Walk a list to its end, `limit` at a time. */
async function walk<T>(read: (extra: Record<string, string>) => Promise<{ items: T[]; pagination: Page<T>["pagination"] }>, limit: number) {
  const seen: T[] = []
  const pages: number[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 200; guard++) {
    const page: Page<T> = await read({ limit: String(limit), ...(cursor ? { cursor } : {}) })
    seen.push(...page.items)
    pages.push(page.items.length)
    if (!page.pagination.hasMore) return { seen, pages }
    expect(page.pagination.nextCursor).toBeTruthy()
    cursor = page.pagination.nextCursor
  }
  throw new Error("the list never ended")
}

describe("the inbox", () => {
  const TOTAL = 125
  let expected: string[] = []

  beforeAll(async () => {
    const others = await crowd("lp-c", TOTAL)
    const base = Date.now() - 10_000_000
    // 5 with nothing said (they lead), the rest with messages; a block of 10 share one instant.
    const rows = others.map((other, i) => ({
      user1_id: me.id < other ? me.id : other,
      user2_id: me.id < other ? other : me.id,
      created_at: new Date(base + i * 1000),
      last_message_at: i < 5 ? null : new Date(base + (i < 15 ? 5_000_000 : 6_000_000 + i * 1000)),
    }))
    await db.private_conversations.createMany({ data: rows })
    expected = (
      await db.private_conversations.findMany({
        where: { OR: [{ user1_id: me.id }, { user2_id: me.id }] },
        select: { id: true, last_message_at: true, created_at: true },
      })
    )
      .sort((a, b) => {
        if ((a.last_message_at === null) !== (b.last_message_at === null)) return a.last_message_at === null ? -1 : 1
        const t = (b.last_message_at?.getTime() ?? 0) - (a.last_message_at?.getTime() ?? 0)
        return t || b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1)
      })
      .map((c) => c.id)
  })

  const read = async (extra: Record<string, string>) => {
    const res = await get(inbox, "/api/mobile/conversations", extra)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { conversations: { id: string }[]; pagination: Page<unknown>["pagination"] } }
    return { items: data.conversations, pagination: data.pagination }
  }

  it("with neither limit nor cursor (an installed build) answers up to 200: all 125, in order, nothing more to fetch", async () => {
    const { items, pagination } = await read({})
    expect(items.map((c) => c.id)).toEqual(expected)
    expect(pagination).toEqual({ limit: 200, hasMore: false, nextCursor: null, totalCount: TOTAL })
  })

  it("a client that pages and names no limit gets the default 50, with a cursor and the whole count", async () => {
    const first = await read({ limit: "50" })
    const { items, pagination } = await read({ cursor: first.pagination.nextCursor! })
    expect(first.items).toHaveLength(50)
    expect(first.pagination).toMatchObject({ limit: 50, hasMore: true, totalCount: TOTAL })
    expect(items.map((c) => c.id)).toEqual(expected.slice(50, 100))
    expect(pagination.limit).toBe(50)
  })

  it("walks to the end in order with no row repeated or lost, empty conversations leading", async () => {
    const { seen, pages } = await walk(read, 40)
    expect(seen.map((c) => c.id)).toEqual(expected)
    expect(pages).toEqual([40, 40, 40, 5])
  })

  it("holds limit to 100 and refuses a cursor that is not ours", async () => {
    expect((await read({ limit: "1000" })).items).toHaveLength(100)
    expect((await get(inbox, "/api/mobile/conversations", { cursor: "not-a-cursor" })).status).toBe(400)
    expect((await get(inbox, "/api/mobile/conversations", { limit: "abc" })).status).toBe(200)
  })

  it("a person with none gets an empty first page and a total of 0", async () => {
    const lonely = await makeUser(testId("lp-lonely"))
    users.push(lonely)
    const { email } = await db.user.findUniqueOrThrow({ where: { id: lonely }, select: { email: true } })
    const res = await inbox.GET(new NextRequest("http://localhost/api/mobile/conversations", { headers: { authorization: `Bearer ${signAccessToken(lonely, email)}` } }))
    expect((await res.json()).data).toMatchObject({ conversations: [], pagination: { hasMore: false, nextCursor: null, totalCount: 0 } })
  })
})

describe("friends", () => {
  const TOTAL = 230
  let expected: string[] = []
  beforeAll(async () => {
    const others = await crowd("lp-f", TOTAL)
    const same = new Date(Date.now() - 5_000_000) // 100 share one instant
    const base = Date.now() - 4_000_000
    await db.friendships.createMany({
      data: others.map((other, i) => ({
        user1_id: me.id < other ? me.id : other,
        user2_id: me.id < other ? other : me.id,
        created_at: i < 100 ? same : new Date(base + i * 1000),
      })),
    })
    expected = (await db.friendships.findMany({ where: { OR: [{ user1_id: me.id }, { user2_id: me.id }] }, orderBy: [{ created_at: "desc" }, { id: "desc" }], select: { user1_id: true, user2_id: true } })).map((f) =>
      f.user1_id === me.id ? f.user2_id : f.user1_id
    )
  })
  const read = async (extra: Record<string, string>) => {
    const res = await get(friendsRoute, "/api/mobile/friends", extra)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { friends: { userId: string }[]; count: number; pagination: Page<unknown>["pagination"] } }
    expect(data.count).toBe(TOTAL)
    return { items: data.friends, pagination: data.pagination }
  }

  it("with neither limit nor cursor answers up to 200 of 230, and says there is more; count and totalCount are the whole list", async () => {
    const { items, pagination } = await read({})
    expect(items).toHaveLength(200)
    expect(pagination).toMatchObject({ limit: 200, hasMore: true, totalCount: TOTAL })
  })
  it("a client that pages and names no limit gets the default 100", async () => {
    const { items, pagination } = await read({ cursor: (await read({ limit: "100" })).pagination.nextCursor! })
    expect(items).toHaveLength(100)
    expect(pagination.limit).toBe(100)
  })
  it("walks the whole list through 100 rows sharing one timestamp", async () => {
    const { seen, pages } = await walk(read, 37)
    expect(seen.map((f) => f.userId)).toEqual(expected)
    expect(seen).toHaveLength(TOTAL)
    expect(pages.at(-1)).toBe(TOTAL % 37)
  })
  it("leaves out a blocked friend in the query, so a page is still full", async () => {
    const victim = expected[0]
    await db.blocked_users.create({ data: { blocker_id: me.id, blocked_id: victim } })
    const res = await get(friendsRoute, "/api/mobile/friends", { limit: "50" })
    const { data } = (await res.json()) as { data: { friends: { userId: string }[]; count: number } }
    expect(data.friends).toHaveLength(50)
    expect(data.friends.map((f) => f.userId)).not.toContain(victim)
    expect(data.count).toBe(TOTAL - 1)
    await db.blocked_users.deleteMany({ where: { blocker_id: me.id } })
  })
})

describe("friend requests", () => {
  const IN = 70
  const OUT = 55
  beforeAll(async () => {
    const senders = await crowd("lp-ri", IN)
    const targets = await crowd("lp-ro", OUT)
    const at = new Date(Date.now() - 3_000_000)
    await db.friend_requests.createMany({
      data: [
        ...senders.map((s, i) => ({ sender_id: s, recipient_id: me.id, created_at: i < 30 ? at : new Date(at.getTime() + i * 1000) })),
        ...targets.map((t) => ({ sender_id: me.id, recipient_id: t, created_at: at })),
      ],
    })
  })
  const ask = async (extra: Record<string, string>) => {
    const res = await get(requestsRoute, "/api/mobile/friends/requests", extra)
    return { status: res.status, body: (await res.json()) as { data: { incoming?: { id: string }[]; outgoing?: { id: string }[]; pagination: Record<string, Page<unknown>["pagination"]> } } }
  }

  it("with neither limit nor cursor answers up to 200 of each: all of them, and each list's total", async () => {
    const { body } = await ask({})
    expect(body.data.incoming).toHaveLength(IN)
    expect(body.data.outgoing).toHaveLength(OUT)
    expect(body.data.pagination.incoming).toEqual({ limit: 200, hasMore: false, nextCursor: null, totalCount: IN })
    expect(body.data.pagination.outgoing).toEqual({ limit: 200, hasMore: false, nextCursor: null, totalCount: OUT })
  })

  it("a client that pages gets 50 of each by default", async () => {
    const { body } = await ask({ limit: "50" })
    expect(body.data.incoming).toHaveLength(50)
    expect(body.data.outgoing).toHaveLength(50)
    expect(body.data.pagination.incoming).toMatchObject({ limit: 50, hasMore: true, totalCount: IN })
    const cursor = body.data.pagination.incoming.nextCursor!
    const next = await ask({ list: "incoming", cursor })
    expect(next.body.data.incoming).toHaveLength(IN - 50)
    expect(next.body.data.pagination.incoming.limit).toBe(50)
  })

  it.each([["incoming", IN], ["outgoing", OUT]] as const)("walks %s alone to its end", async (list, total) => {
    const { seen } = await walk(async (extra) => {
      const { status, body } = await ask({ list, ...extra })
      expect(status).toBe(200)
      expect(body.data[list === "incoming" ? "outgoing" : "incoming"]).toBeUndefined()
      return { items: body.data[list]!, pagination: body.data.pagination[list] }
    }, 20)
    expect(seen).toHaveLength(total)
    expect(new Set(seen.map((r) => r.id)).size).toBe(total)
  })

  it("refuses a cursor with no list, an unknown list, and a cursor that is not ours", async () => {
    const first = await ask({ list: "incoming", limit: "10" })
    const cursor = first.body.data.pagination.incoming.nextCursor!
    expect((await ask({ cursor })).status).toBe(400)
    expect((await ask({ list: "sideways" })).status).toBe(400)
    expect((await ask({ list: "incoming", cursor: "x" })).status).toBe(400)
  })
})

describe("blocked people", () => {
  const TOTAL = 140
  beforeAll(async () => {
    const others = await crowd("lp-b", TOTAL)
    const at = new Date(Date.now() - 2_000_000)
    await db.blocked_users.createMany({ data: others.map((blocked_id) => ({ blocker_id: me.id, blocked_id, created_at: at })) })
  })
  const read = async (extra: Record<string, string>) => {
    const res = await get(blockedRoute, "/api/mobile/users/blocked", extra)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { users: { blocked_id: string; blocked_at: string }[]; pagination: Page<unknown>["pagination"] } }
    return { items: data.users, pagination: data.pagination }
  }
  it("with neither limit nor cursor answers all 140 (up to 200); a paging client's first page is 100; every ref once", async () => {
    const legacy = await read({})
    expect(legacy.items).toHaveLength(TOTAL)
    expect(legacy.pagination).toEqual({ limit: 200, hasMore: false, nextCursor: null, totalCount: TOTAL })
    const first = await read({ limit: "100" })
    expect(first.items).toHaveLength(100)
    expect(first.pagination).toMatchObject({ hasMore: true, totalCount: TOTAL })
    const { seen } = await walk(read, 45)
    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen.map((u) => u.blocked_id)).size).toBe(TOTAL)
  })
})

describe("the board", () => {
  const TOTAL = 130
  let eventId = ""
  beforeAll(async () => {
    const host = await makeUser(testId("lp-host"), "organizer")
    users.push(host)
    eventId = await makeEvent(host)
    events.push(eventId)
    const start = new Date(Date.now() + 24 * 3600_000)
    await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3600_000) } })
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: me.id, status: "going" } })
    // Able to take part: onboarded, an adult age on file.
    const born = new Date()
    born.setFullYear(born.getFullYear() - 30)
    await db.profiles.upsert({ where: { id: me.id }, create: { id: me.id, name: "Me", onboarded: true, date_of_birth: born }, update: { onboarded: true, date_of_birth: born } })
    const authors = await crowd("lp-p", TOTAL)
    const at = new Date(Date.now() - 1_000_000)
    await db.board_posts.createMany({
      data: authors.map((author_id, i) => ({ event_id: eventId, author_id, kind: "chat" as const, body: `post ${i}`, created_at: i < 60 ? at : new Date(at.getTime() + i * 1000) })),
    })
  })
  const read = async (extra: Record<string, string>) => {
    const res = await boardRoute.GET(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/board?${new URLSearchParams(extra)}`, { headers: { authorization: `Bearer ${me.token}` } }),
      { params: Promise.resolve({ eventId }) }
    )
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { posts: { id: string }[]; pagination: Page<unknown>["pagination"] } }
    return { items: data.posts, pagination: data.pagination }
  }
  it("is no longer cut at 100: the board stays at 100 for everybody, says there is more, and the cursor reaches it", async () => {
    const first = await read({})
    expect(first.items).toHaveLength(100)
    expect(first.pagination).toMatchObject({ hasMore: true, totalCount: TOTAL })
    const { seen } = await walk(read, 100)
    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen.map((p) => p.id)).size).toBe(TOTAL)
  })
  it("walks through 60 posts sharing one instant without losing one", async () => {
    const { seen } = await walk(read, 23)
    expect(new Set(seen.map((p) => p.id)).size).toBe(TOTAL)
  })
})
