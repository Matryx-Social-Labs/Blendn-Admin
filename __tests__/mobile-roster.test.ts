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
process.env.NEXTAUTH_SECRET = "mobile-roster-test-secret-of-32-characters"
const mockDb = {
  events: { findUnique: jest.fn() },
  event_check_ins: { findFirst: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  // The roster consults blocks now: a block is a safety promise, not a mute,
  // and this is the one screen that answers "is he in this room".
  blocked_users: { findMany: jest.fn() },
  // The reveal flag: "Show who I am" in the room. Empty unless a case sets it.
  event_match_preferences: { findMany: jest.fn() },
  // The rest of the room identity rule (`visibleInRoom`): closed pairs and
  // friends who let friends recognise them in rooms. Empty unless a case sets it.
  private_conversations: { findMany: jest.fn() },
  friendships: { findMany: jest.fn() },
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
import { resolveUserRef } from "@/lib/room-handle"

const EVENT = "11111111-1111-1111-1111-111111111111"
const params = Promise.resolve({ eventId: EVENT })
const req = () => new NextRequest(`https://api.blendn.app/api/mobile/events/${EVENT}/checkins`)

/** Someone the old filter excluded: no name, no photos, standing in the room. */
const bare = {
  user: { id: "u2", profile: { age: 29, location: "Bengaluru" } },
  check_in_time: new Date("2026-08-10T18:00:00.000Z"),
}

/** The roster's rows. `visibleInRoom`'s own read — was the viewer here? — answers yes. */
let rows: unknown[] = []
const roster = (r: unknown[]) => {
  rows = r
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: "u1" })
  mockDb.events.findUnique.mockResolvedValue({ id: EVENT })
  mockDb.event_check_ins.findFirst.mockResolvedValue({ id: "ci1" })
  mockDb.event_check_ins.count.mockResolvedValue(1)
  roster([bare])
  mockDb.event_check_ins.findMany.mockImplementation(async (args: { select?: { user_id?: boolean } }) =>
    args.select?.user_id ? [{ user_id: "u1" }] : rows
  )
  mockDb.event_match_preferences.findMany.mockResolvedValue([])
  mockDb.blocked_users.findMany.mockResolvedValue([])
  mockDb.private_conversations.findMany.mockResolvedValue([])
  mockDb.friendships.findMany.mockResolvedValue([])
})

describe("blocks reach the roster", () => {
  /*
   * `/matches` has filtered on blocks since it shipped; this endpoint never
   * did, so the one screen that names who is physically in the room with you
   * would still list somebody you blocked, and still count them.
   */
  it("excludes a blocked person from both the list and the count", async () => {
    mockDb.blocked_users.findMany.mockResolvedValue([{ blocker_id: "u1", blocked_id: "u9" }])

    await GET(req(), { params: Promise.resolve({ eventId: EVENT }) })

    for (const call of [
      mockDb.event_check_ins.count.mock.calls[0][0],
      mockDb.event_check_ins.findMany.mock.calls[0][0],
    ]) {
      expect(call.where.user_id).toEqual({ notIn: ["u9"] })
    }
  })

  it("holds whichever direction the block runs in", async () => {
    mockDb.blocked_users.findMany.mockResolvedValue([{ blocker_id: "u9", blocked_id: "u1" }])

    await GET(req(), { params: Promise.resolve({ eventId: EVENT }) })

    expect(mockDb.event_check_ins.findMany.mock.calls[0][0].where.user_id).toEqual({
      notIn: ["u9"],
    })
  })

  it("adds no predicate when nobody is blocked", async () => {
    await GET(req(), { params: Promise.resolve({ eventId: EVENT }) })
    expect(mockDb.event_check_ins.findMany.mock.calls[0][0].where.user_id).toBeUndefined()
  })
})

describe("GET /events/:id/checkins — who counts as present", () => {
  it("does not filter the roster on profile completeness", async () => {
    await GET(req(), { params })
    const where = mockDb.event_check_ins.findMany.mock.calls[0][0].where
    expect(where).toEqual({
      event_id: EVENT,
      status: "checked_in",
      // The one profile predicate that belongs here: "Show online status" off
      // is counted and not listed (SCRUM-141) — and a missing profile row is
      // not "off", so the NULL case is spelled out.
      user: { OR: [{ profile: { is: null } }, { profile: { show_online: true } }] },
    })
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
    // Somebody else, so their handle in this room — resolving to them (SCRUM-371).
    expect(resolveUserRef(body.data.attendees[0].userId)).toEqual({ userId: "u2", eventId: EVENT })
  })

  it("lists the viewer by their own id and everyone else by a handle, never a real id", async () => {
    // The app leaves itself off its own roster by comparing ids, so yours stays
    // real; a friend who holds someone's real id must not find it here.
    roster([
      bare,
      { user: { id: "u1", profile: { age: 30, location: "Bengaluru" } }, check_in_time: bare.check_in_time },
    ])
    const body = await (await GET(req(), { params })).json()
    const ids = body.data.attendees.map((a: { userId: string }) => a.userId)
    expect(ids).toContain("u1")
    expect(ids.filter((id: string) => id !== "u1").every((id: string) => id.startsWith("rh_"))).toBe(true)
    expect(JSON.stringify(body)).not.toContain('"u2"')
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
    roster([
      { ...bare, user: { ...bare.user, name: "Ananya Bhat", profile: { ...bare.user.profile, photos: ["https://cdn/a.jpg"] } } },
    ])
    const body = await (await GET(req(), { params })).json()
    const [a] = body.data.attendees
    expect(a.name).toBe("Cosmic Panda")
    expect(a).not.toHaveProperty("image")
    expect(JSON.stringify(body)).not.toMatch(/photos|image|Ananya/)
  })

  it("shows the real name and photo of someone who chose to, in this room only", async () => {
    /*
     * Driven on iOS: "Show who I am" set the flag, the Grid card read the real
     * name, and this roster beside it still said "Cosmic Panda" (L2.5). Same
     * rule as lib/matching.ts, scoped to the event the flag was set in.
     */
    roster([
      { ...bare, user: { ...bare.user, name: "Ananya Bhat", profile: { ...bare.user.profile, photos: ["https://cdn/a.jpg"] } } },
    ])
    mockDb.event_match_preferences.findMany.mockResolvedValue([{ user_id: "u2" }])
    const body = await (await GET(req(), { params })).json()
    const [a] = body.data.attendees
    expect(a.name).toBe("Ananya Bhat")
    expect(a.image).toBe("https://cdn/a.jpg")
    const where = mockDb.event_match_preferences.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ event_id: EVENT, revealed: true })
  })

  it("names a friend who lets friends recognise them in rooms, as their profile does", async () => {
    /*
     * The profile a card opens honoured "Friends can see who I am in rooms"
     * and this roster did not, so the same friend was "Cosmic Panda" here and
     * their name one tap later. One rule (`visibleInRoom`) now answers both.
     */
    roster([
      { ...bare, user: { ...bare.user, name: "Ananya Bhat", profile: { ...bare.user.profile, photos: ["https://cdn/a.jpg"] } } },
    ])
    const friends = (u2OptedIn: boolean) => [
      {
        user1_id: "u1",
        user2_id: "u2",
        user1: { profile: { friends_see_me_in_rooms: true } },
        user2: { profile: { friends_see_me_in_rooms: u2OptedIn } },
      },
    ]

    mockDb.friendships.findMany.mockResolvedValue(friends(true))
    let [a] = (await (await GET(req(), { params })).json()).data.attendees
    expect(a.name).toBe("Ananya Bhat")
    expect(a.image).toBe("https://cdn/a.jpg")
    expect(a.userId.startsWith("rh_")).toBe(true)

    // The switch is the TARGET's consent: the viewer's own switch does not count.
    mockDb.friendships.findMany.mockResolvedValue(friends(false))
    ;[a] = (await (await GET(req(), { params })).json()).data.attendees
    expect(a.name).toBe("Cosmic Panda")
    expect(a).not.toHaveProperty("image")
  })

  it("falls back to Attendee when the room has no pseudonym for someone", async () => {
    roster([
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
