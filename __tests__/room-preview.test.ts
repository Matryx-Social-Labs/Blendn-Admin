process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

/*
 * `GET /events/:id/room-preview` — the Room seen from the door.
 *
 * Readable by anyone who can open the event, with no check-in, so the rules
 * that matter are the ones that keep an aggregate from naming someone: the
 * floor, and the roster's exclusions (blocks, "show online" off, suspended).
 *
 * `event_check_ins.findMany` answers two questions here: the headcount
 * (`hereCountFor`, the call with `distinct`) and the visible pool.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  user_interests: { findMany: jest.fn() },
  event_check_ins: { findMany: jest.fn() },
  categories: { findMany: jest.fn() },
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
const poolCalls = () =>
  mockDb.event_check_ins.findMany.mock.calls.filter(([args]) => !("distinct" in args))

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
  mockDb.event_check_ins.findMany.mockImplementation(async (args: { distinct?: unknown }) =>
    args.distinct ? Array.from({ length: here }, (_, i) => ({ user_id: `h${i}` })) : pool
  )
})

it("returns hereCount and how many inside share an interest", async () => {
  const res = await call()
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ success: true, data: { hereCount: 6, tasteMatchCount: 2 } })
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
  mockBlocks.mockResolvedValue(["p1"])
  const body = await (await call()).json()
  expect(body.data.tasteMatchCount).toBe(1)
  expect(mockBlocks).toHaveBeenCalledWith(ME)
})

it("is null when fewer than three are inside now, and does not even look", async () => {
  here = 2
  const body = await (await call()).json()
  expect(body.data).toEqual({ hereCount: 2, tasteMatchCount: null })
  expect(poolCalls()).toHaveLength(0)
})

it("answers at exactly three", async () => {
  here = 3
  const body = await (await call()).json()
  expect(body.data).toEqual({ hereCount: 3, tasteMatchCount: 2 })
})

it("counts a person once however many rows they have", async () => {
  pool = [
    person("p1", ["techno"]),
    person("p1", ["techno"]),
    person("p2", ["running"]),
    person("p3", ["running"]),
  ]
  const body = await (await call()).json()
  expect(body.data.tasteMatchCount).toBe(1)
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
