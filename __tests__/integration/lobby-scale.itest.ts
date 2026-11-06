import { NextRequest } from "next/server"

/*
 * A concert-sized Lobby (SCRUM-1026, "Large events"): 2,000 posts, paged 100
 * at a time, every post exactly once, newest first, with the filter counts and
 * the type filter answered by the server. Real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const board = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
const preview = require("@/app/api/mobile/events/[eventId]/board/preview/route") as typeof import("@/app/api/mobile/events/[eventId]/board/preview/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const POSTS = 2_000
const AUTHORS = 40
const users: string[] = []
const events: string[] = []
let eventId = ""
let token = ""

afterAll(async () => {
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.event_favorites.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

beforeAll(async () => {
  const host = await makeUser(testId("scale-host"), "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
  const start = new Date(Date.now() + 24 * 3_600_000)
  await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) } })
  const authors: string[] = []
  for (let i = 0; i < AUTHORS; i++) authors.push(await makeUser(testId(`scale-a${i}`)))
  users.push(...authors)
  const reader = await makeUser(testId("scale-reader"))
  users.push(reader)
  await onboard(reader)
  await db.event_favorites.create({ data: { event_id: eventId, user_id: reader } })
  token = signAccessToken(reader, `${reader}@itest.invalid`)

  // Every third an offer of a ride; the rest split between searches and chat. Some share a created_at, as a burst does.
  const base = Date.now() - POSTS * 1_000
  await db.board_posts.createMany({
    data: Array.from({ length: POSTS }, (_, i) => {
      const kind = i % 3 === 0 ? "offer" : i % 3 === 1 ? "seeking" : "chat"
      return {
        event_id: eventId,
        author_id: authors[i % AUTHORS],
        kind,
        ...(kind === "offer" && { sub_kind: "ride" as const, spaces_left: 2 }),
        body: `Post ${i}`,
        created_at: new Date(base + Math.floor(i / 2) * 1_000),
      }
    }),
  })
})

const get = async (query: string) => {
  const res = await board.GET(new NextRequest(`http://localhost/x${query}`, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ eventId }) })
  expect(res.status).toBe(200)
  return (await res.json()).data
}

describe("2,000 posts", () => {
  it("pages through every post exactly once, newest first, and fast", async () => {
    const seen: { id: string; createdAt: string }[] = []
    let cursor: string | null = null
    let pages = 0
    let slowest = 0
    do {
      const started = Date.now()
      const page: { posts: { id: string; createdAt: string }[]; pagination: { nextCursor: string | null; totalCount: number } } = await get(`?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      slowest = Math.max(slowest, Date.now() - started)
      expect(page.pagination.totalCount).toBe(POSTS)
      seen.push(...page.posts)
      cursor = page.pagination.nextCursor
      pages++
    } while (cursor && pages < 50)

    expect(pages).toBe(POSTS / 100)
    expect(new Set(seen.map((p) => p.id)).size).toBe(POSTS)
    const times = seen.map((p) => Date.parse(p.createdAt))
    expect(times.every((t, i) => i === 0 || t <= times[i - 1])).toBe(true)
    // Local Postgres; a generous ceiling that a missing index or a per-row query would blow.
    expect(slowest).toBeLessThan(2_000)
  })

  it("counts every chip from the server on the first page", async () => {
    const first = await get("?limit=20")
    expect(first.posts).toHaveLength(20)
    expect(first.counts).toEqual({ all: 2_000, offer: 667, seeking: 667, chat: 666, offerRides: 667, mine: 0, replies: 0 })
  })

  it("filters by type on the server, with the filtered total", async () => {
    const offers = await get("?kind=offer&limit=100")
    expect(offers.pagination.totalCount).toBe(667)
    expect(offers.posts.every((p: { kind: string }) => p.kind === "offer")).toBe(true)
  })

  it("previews two posts and the counts in one call", async () => {
    const res = await preview.GET(new NextRequest(`http://localhost/x`, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ eventId }) })
    const data = (await res.json()).data
    expect(data.latest).toHaveLength(2)
    expect(data.counts).toMatchObject({ all: 2_000, offerRides: 667 })
  })
})
