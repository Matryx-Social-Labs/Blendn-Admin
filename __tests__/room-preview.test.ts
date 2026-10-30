process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

/*
 * `GET /events/:id/room-preview` — the Room seen from the door.
 *
 * Readable by anyone who can open the event, with no check-in, so the rules
 * that matter are the ones that keep an aggregate from naming someone: the
 * floor, and the roster's exclusions (blocks, "show online" off, suspended).
 *
 * The headcount is `event_check_ins.count` (`hereCountFor`); the visible pool
 * is `event_check_ins.findMany`.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  user_interests: { findMany: jest.fn() },
  event_check_ins: { findMany: jest.fn(), count: jest.fn() },
  categories: { findMany: jest.fn() },
  // Friends leave the count (lib/room-people.ts); none here.
  friendships: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  ended_friendships: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a) }))

const mockAccess = jest.fn()
jest.mock("@/lib/event-access", () => ({
  attendeeEventAccess: (...a: unknown[]) => mockAccess(...a),
  eventAccessResponse: jest.requireActual("@/lib/event-access").eventAccessResponse,
}))

const mockBlocks = jest.fn()
jest.mock("@/lib/conversations", () => ({ blockCounterparties: (...a: unknown[]) => mockBlocks(...a) }))
jest.mock("@/lib/rate-limit", () => ({ rateLimit: async () => null, userLimit: () => ({}) }))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/mobile/events/[eventId]/room-preview/route"

const EVENT = "22222222-2222-2222-2222-222222222222"
const ME = "me"

const call = () =>
  GET(new NextRequest(`https://api.blendn.app/api/mobile/events/${EVENT}/room-preview`), {
    params: Promise.resolve({ eventId: EVENT }),
  })

const person = (id: string, interests: string[]) => ({
  user_id: id,
  user: { user_interests: interests.map((category_id) => ({ category_id })) },
})

let here = 6
let pool: ReturnType<typeof person>[] = []
const poolCalls = () => mockDb.event_check_ins.findMany.mock.calls

beforeEach(() => {
  jest.clearAllMocks()
  here = 6
  mockAuth.mockResolvedValue({ userId: ME, email: "me@b.com" })
  mockAccess.mockResolvedValue(null)
  mockBlocks.mockResolvedValue([])
  mockDb.user_interests.findMany.mockResolvedValue([{ category_id: "techno" }])
  // techno and house are both Music.
  mockDb.categories.findMany.mockResolvedValue([
    { id: "techno", parent_id: "music" },
    { id: "house", parent_id: "music" },
    { id: "running", parent_id: "sports" },
  ])
  pool = [
    person("p1", ["techno"]),
    person("p2", ["house"]), // shares the parent, as on the match deck
    person("p3", ["running"]),
    person("p4", []),
  ]
  mockDb.event_check_ins.count.mockImplementation(async () => here)
  mockDb.event_check_ins.findMany.mockImplementation(async () => pool)
})

it("returns hereCount and the bucket of how many inside share an interest", async () => {
  pool = [person("p1", ["techno"]), person("p2", ["house"]), person("p3", ["techno"]), person("p4", ["techno"]), person("p5", ["techno"]), person("p6", [])]
  here = 7
  const res = await call()
  expect(res.status).toBe(200)
  // Five share (techno, house under Music, techno x3): the bucket's floor, 3, never 5.
  expect(await res.json()).toEqual({ success: true, data: { hereCount: 7, tasteMatchCount: 3 } })
})

it("says nothing under three who share, even with a crowd inside (the figure is a bucket's floor, never one or two)", async () => {
  const body = await (await call()).json() // p1 and p2 share: two
  expect(body.data).toEqual({ hereCount: 6, tasteMatchCount: null })
})

it("uses the roster's exclusions: not me, attendees inside now, show_online on, not suspended", async () => {
  await call()
  const where = poolCalls()[0]![0].where
  expect(where).toMatchObject({
    event_id: EVENT,
    status: "checked_in",
    kind: "attendee",
    user_id: { not: ME },
    user: {
      suspended_at: null,
      OR: [{ profile: { is: null } }, { profile: { show_online: true } }],
    },
  })
})

it("leaves out anyone in a block relationship either way", async () => {
  pool = [person("p1", ["techno"]), person("p2", ["techno"]), person("p3", ["techno"]), person("p4", ["techno"])]
  mockBlocks.mockResolvedValue(["p1", "p2"]) // p3 and p4 are two: under the bucket; without the block it would be four: three
  const body = await (await call()).json()
  expect(body.data.tasteMatchCount).toBeNull()
  expect(mockBlocks).toHaveBeenCalledWith(ME)
})

it("is null when fewer than three are inside now, and does not even look", async () => {
  here = 2
  const body = await (await call()).json()
  expect(body.data).toEqual({ hereCount: 2, tasteMatchCount: null })
  expect(poolCalls()).toHaveLength(0)
})

/*
 * SCRUM-671: the figure is drawn from the visible people, not from hereCount. A
 * room of the viewer, one hidden person (show_online off, a block, a friend,
 * suspended) and one visible person has hereCount 3, but the taste number would
 * then be that one visible person's overlap with you. The bucket (three or more
 * sharers, none of them the viewer) is that floor.
 */
it("is null when hidden people make up the floor and one visible person is left", async () => {
  here = 3
  pool = [person("p1", ["techno"])]
  const body = await (await call()).json()
  expect(body.data).toEqual({ hereCount: 3, tasteMatchCount: null })
})

it("is null when the viewer's blocks leave one visible person in a room of three", async () => {
  here = 3
  pool = [person("p1", ["techno"]), person("p2", ["techno"])]
  mockBlocks.mockResolvedValue(["p2"])
  const body = await (await call()).json()
  expect(body.data).toEqual({ hereCount: 3, tasteMatchCount: null })
})

it("counts a person once however many rows they have", async () => {
  pool = [
    person("p1", ["techno"]),
    person("p1", ["techno"]),
    person("p1", ["techno"]),
    person("p2", ["techno"]),
    person("p3", ["running"]),
  ]
  // p1 three times is one person: two share (p1, p2), not four.
  const body = await (await call()).json()
  expect(body.data.tasteMatchCount).toBeNull()
})

it("404s an event the viewer cannot open, like GET /events/:id", async () => {
  mockAccess.mockResolvedValue({ kind: "not_found" })
  const res = await call()
  expect(res.status).toBe(404)
  expect(mockAccess).toHaveBeenCalledWith(ME, EVENT, "view")
})

it("401s without a token", async () => {
  mockAuth.mockResolvedValue(null)
  expect((await call()).status).toBe(401)
})

/*
 * SCRUM-914: the figure is a bucket's floor, so two reads around one person's
 * join differ only when the join crosses a bucket edge, and a viewer who edits
 * their own interests between reads learns the bucket of each, not the count.
 *
 * Ceiling, stated: at an edge (the third sharer, the tenth) a read before and a
 * read after a sole joiner differ, and the joiner's overlap with the viewer is
 * read out. The reader cannot tell they are at an edge, but could walk their
 * interests to one. Closing that takes a per-viewer stability window or a rate
 * limit, which the owner did not pick.
 */
describe("the taste figure is a bucket, never the count (SCRUM-914)", () => {
  const sharers = (n: number, others = 0) => [
    ...Array.from({ length: n }, (_, i) => person(`s${i}`, ["techno"])),
    ...Array.from({ length: others }, (_, i) => person(`o${i}`, ["running"])),
  ]
  const read = async (n: number, others = 0) => {
    pool = sharers(n, others)
    here = pool.length + 1
    return (await (await call()).json()).data.tasteMatchCount as number | null
  }

  it("takes only null, 3 or 10 at any room size", async () => {
    for (let n = 0; n <= 30; n++) expect([null, 3, 10]).toContain(await read(n, 2))
    expect(await read(2)).toBeNull()
    expect(await read(3)).toBe(3)
    expect(await read(9)).toBe(3)
    expect(await read(10)).toBe(10)
    expect(await read(40)).toBe(10)
  })

  it("is unchanged by one more person joining, except where the join crosses a bucket edge", async () => {
    const edges: number[] = []
    for (let n = 0; n <= 30; n++) {
      if ((await read(n, 2)) !== (await read(n + 1, 2))) edges.push(n + 1)
    }
    expect(edges).toEqual([3, 10])
  })

  it("does not move when the joiner shares nothing", async () => {
    for (let n = 0; n <= 14; n++) expect(await read(n, 3)).toBe(await read(n, 4))
  })

  it("shows the same figure to a viewer who swaps interests between reads, while both sit in one bucket", async () => {
    // Five people like techno, four like running, ten others like neither: 5 and 4 are both "3".
    pool = [
      ...Array.from({ length: 5 }, (_, i) => person(`t${i}`, ["techno"])),
      ...Array.from({ length: 4 }, (_, i) => person(`r${i}`, ["running"])),
      ...Array.from({ length: 10 }, (_, i) => person(`n${i}`, [])),
    ]
    here = pool.length + 1
    mockDb.user_interests.findMany.mockResolvedValue([{ category_id: "techno" }])
    const asTechno = (await (await call()).json()).data.tasteMatchCount
    mockDb.user_interests.findMany.mockResolvedValue([{ category_id: "running" }])
    const asRunning = (await (await call()).json()).data.tasteMatchCount
    expect([asTechno, asRunning]).toEqual([3, 3])
  })

  it("is null, not zero, for a viewer with no interests", async () => {
    pool = sharers(12)
    here = 13
    mockDb.user_interests.findMany.mockResolvedValue([])
    expect((await (await call()).json()).data.tasteMatchCount).toBeNull()
  })
})
