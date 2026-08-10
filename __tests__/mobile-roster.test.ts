/*
 * Who the room says is in it.
 *
 * The roster used to be filtered on `onboarded`, a non-null name and a
 * non-empty photo array — three fields it does not return. Someone who had
 * checked in was absent from the list, and from the count, with nothing in the
 * response that could have explained why. These tests are mostly about the
 * *query*, because the defect was in the `where` clause and invisible in the
 * body: a filtered roster and an unfiltered one look identical when the fixture
 * happens to have complete profiles.
 */
const mockDb = {
  events: { findUnique: jest.fn() },
  event_check_ins: { findFirst: jest.fn(), count: jest.fn(), findMany: jest.fn() },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a) }))

jest.mock("@/lib/anonymous-names", () => ({
  pseudonymsForEvent: jest.fn().mockResolvedValue(new Map([["u2", "Cosmic Panda"]])),
}))

jest.mock("@/lib/location", () => ({
  normalizeLocationToCity: jest.fn().mockImplementation(async (l: string | null) => l),
}))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/mobile/events/[eventId]/checkins/route"

const EVENT = "11111111-1111-1111-1111-111111111111"
const params = Promise.resolve({ eventId: EVENT })
const req = () => new NextRequest(`https://api.blendn.app/api/mobile/events/${EVENT}/checkins`)

/** Someone the old filter excluded: no name, no photos, standing in the room. */
const bare = {
  user: { id: "u2", profile: { age: 29, location: "Bengaluru" } },
  check_in_time: new Date("2026-08-10T18:00:00.000Z"),
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: "u1" })
  mockDb.events.findUnique.mockResolvedValue({ id: EVENT })
  mockDb.event_check_ins.findFirst.mockResolvedValue({ id: "ci1" })
  mockDb.event_check_ins.count.mockResolvedValue(1)
  mockDb.event_check_ins.findMany.mockResolvedValue([bare])
})

describe("GET /events/:id/checkins — who counts as present", () => {
  it("does not filter the roster on profile completeness", async () => {
    await GET(req(), { params })
    const where = mockDb.event_check_ins.findMany.mock.calls[0][0].where
    expect(where).toEqual({ event_id: EVENT, status: "checked_in" })
    expect(JSON.stringify(where)).not.toMatch(/onboarded|photos/)
  })

  it("counts on exactly the same predicate it lists on", async () => {
    // A count and a list that disagree produce a pagination footer promising
    // people the pages never contain.
    await GET(req(), { params })
    expect(mockDb.event_check_ins.count.mock.calls[0][0].where).toEqual(
      mockDb.event_check_ins.findMany.mock.calls[0][0].where
    )
  })

  it("returns someone with no name and no photos", async () => {
    const body = await (await GET(req(), { params })).json()
    expect(body.data.attendees).toHaveLength(1)
    expect(body.data.attendees[0].userId).toBe("u2")
  })

  it("lists only people still checked in, not everyone who ever was", async () => {
    // The deliberate difference from `/matches`, which selects on
    // `check_in_time: { not: null }`. Someone who checked out stays matchable
    // and stops being listed as present.
    await GET(req(), { params })
    expect(mockDb.event_check_ins.findMany.mock.calls[0][0].where.status).toBe("checked_in")
  })
})

describe("GET /events/:id/checkins — what it discloses", () => {
  it("still returns the pseudonym, never the real name or photo", async () => {
    const body = await (await GET(req(), { params })).json()
    const [a] = body.data.attendees
    expect(a.name).toBe("Cosmic Panda")
    expect(a).not.toHaveProperty("image")
    expect(JSON.stringify(body)).not.toMatch(/photos|image/)
  })

  it("falls back to Attendee when the room has no pseudonym for someone", async () => {
    mockDb.event_check_ins.findMany.mockResolvedValue([
      { ...bare, user: { ...bare.user, id: "stranger" } },
    ])
    const body = await (await GET(req(), { params })).json()
    expect(body.data.attendees[0].name).toBe("Attendee")
  })

  it("refuses a caller who was never in the room", async () => {
    mockDb.event_check_ins.findFirst.mockResolvedValue(null)
    expect((await GET(req(), { params })).status).toBe(403)
    expect(mockDb.event_check_ins.findMany).not.toHaveBeenCalled()
  })

  it("refuses an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await GET(req(), { params })).status).toBe(401)
  })
})
