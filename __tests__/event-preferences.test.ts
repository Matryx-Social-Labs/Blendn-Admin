/*
 * One answer per person per event, on an event with more than one day.
 *
 * `intent` and `revealed` lived on `event_check_ins`, which was right while a
 * check-in was one row per event. Occurrences changed the key to
 * `(occurrence_id, user_id)`, so a five-day conference gives one person five
 * rows — and both readers used `findFirst({ event_id, user_id })` with no
 * ordering. Postgres may return any matching row for an unordered LIMIT 1, so
 * which day's answer you got could change with a vacuum or a plan change.
 *
 * These tests use a three-day event throughout, because on a single-day event
 * every version of this code agrees and the bug is invisible.
 */
const mockDb = {
  // `matchesForEvent` runs the co-attendance count as one raw query for the
  // whole room rather than a query per candidate. Returns nothing here: these
  // tests are about day-folding and preferences, and a pair with no shared
  // history is the case that must keep ranking exactly as it did.
  $queryRaw: jest.fn().mockResolvedValue([]),
  event_check_ins: { findFirst: jest.fn(), findMany: jest.fn() },
  event_match_preferences: { findMany: jest.fn() },
  profiles: { findUnique: jest.fn() },
  user_interests: { findMany: jest.fn() },
  blocked_users: { findMany: jest.fn() },
  // `groupBy` counts likes received, which feeds the exposure damping. A later
  // duplicate key would silently win, so it is extended here rather than added
  // again above.
  event_likes: { findMany: jest.fn(), groupBy: jest.fn() },
  chat_group_members: { findMany: jest.fn() },
  categories: { findMany: jest.fn() },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/conversations", () => ({
  openConversation: jest.fn(),
  // `matchesForEvent` excludes pairs who left each other. Empty here: these
  // fixtures are about multi-day check-ins, not about leaving.
  closedPairKeys: jest.fn().mockResolvedValue(new Set<string>()),
  ConversationClosedError: class ConversationClosedError extends Error {},
}))

import { matchesForEvent } from "@/lib/matches"

const EVENT = "11111111-1111-1111-1111-111111111111"
const VIEWER = "viewer"
const DAY1 = new Date("2026-08-10T18:00:00.000Z")
const DAY2 = new Date("2026-08-11T18:00:00.000Z")
const DAY3 = new Date("2026-08-12T18:00:00.000Z")

/** One check-in row — a person who came on three days has three of these. */
const checkIn = (userId: string, at: Date, status = "checked_in") => ({
  user_id: userId,
  status,
  check_in_time: at,
  user: {
    name: "Real Name",
    image: null,
    profile: {
      intent_default: [],
      photos: [],
      work_field: null,
      gender: null,
      interested_in: [],
    },
    user_interests: [],
  },
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.event_check_ins.findFirst.mockResolvedValue({ id: "viewer-checkin" })
  mockDb.profiles.findUnique.mockResolvedValue({
    intent_default: [],
    work_field: null,
    gender: null,
    interested_in: [],
  })
  mockDb.user_interests.findMany.mockResolvedValue([])
  mockDb.event_match_preferences.findMany.mockResolvedValue([])
  mockDb.blocked_users.findMany.mockResolvedValue([])
  mockDb.event_likes.findMany.mockResolvedValue([])
  mockDb.event_likes.groupBy.mockResolvedValue([])
  mockDb.chat_group_members.findMany.mockResolvedValue([])
  mockDb.categories.findMany.mockResolvedValue([])
})

describe("a three-day event", () => {
  it("lists someone who came on all three days exactly once", async () => {
    /*
     * The bug this replaces, and it was visible on screen: the map over
     * check-in rows produced one card per *day attended*, so a regular at a
     * five-day conference appeared five times in the same list.
     */
    mockDb.event_check_ins.findMany.mockResolvedValue([
      checkIn("regular", DAY1),
      checkIn("regular", DAY2),
      checkIn("regular", DAY3),
    ])

    const matches = await matchesForEvent(EVENT, VIEWER)
    expect(matches).toHaveLength(1)
    expect(matches![0].userId).toBe("regular")
  })

  it("takes presence from their most recent day, not an arbitrary one", async () => {
    // They were here on Monday and left; on Wednesday they are inside. Reading
    // whichever row came back first made "in the room now" a coin toss.
    mockDb.event_check_ins.findMany.mockResolvedValue([
      checkIn("regular", DAY3, "checked_in"),
      checkIn("regular", DAY1, "checked_out"),
    ])

    const matches = await matchesForEvent(EVENT, VIEWER)
    expect(matches![0].insideNow).toBe(true)
  })

  it("is unaffected by the order the rows come back in", async () => {
    // The property that matters: Postgres is entitled to return these in any
    // order, and the answer must not depend on which.
    const rows = [checkIn("regular", DAY1), checkIn("regular", DAY3), checkIn("regular", DAY2)]

    mockDb.event_check_ins.findMany.mockResolvedValue(rows)
    const forward = await matchesForEvent(EVENT, VIEWER)

    mockDb.event_check_ins.findMany.mockResolvedValue([...rows].reverse())
    const backward = await matchesForEvent(EVENT, VIEWER)

    expect(forward).toEqual(backward)
  })
})

describe("preferences are read per event, not per check-in", () => {
  it("uses the one stored answer whichever day they came", async () => {
    mockDb.event_check_ins.findMany.mockResolvedValue([
      checkIn("regular", DAY1),
      checkIn("regular", DAY3),
    ])
    mockDb.event_match_preferences.findMany.mockResolvedValue([
      { user_id: "regular", intent: ["networking"], revealed: false },
    ])
    mockDb.profiles.findUnique.mockResolvedValue({
      intent_default: ["networking"],
      work_field: null,
      gender: null,
      interested_in: [],
    })
    mockDb.event_match_preferences.findMany.mockResolvedValue([
      { user_id: "regular", intent: ["networking"], revealed: false },
      { user_id: VIEWER, intent: ["networking"], revealed: false },
    ])

    const matches = await matchesForEvent(EVENT, VIEWER)
    expect(matches![0].sharedIntents).toEqual(["networking"])
  })

  it("queries the preferences table once for the whole room", async () => {
    // Not once per candidate: a hundred-person room is one query, not a
    // hundred, and the row count does not depend on how many days each came.
    mockDb.event_check_ins.findMany.mockResolvedValue([
      checkIn("a", DAY1),
      checkIn("b", DAY1),
      checkIn("b", DAY2),
    ])

    await matchesForEvent(EVENT, VIEWER)
    expect(mockDb.event_match_preferences.findMany).toHaveBeenCalledTimes(1)
    expect(mockDb.event_match_preferences.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { event_id: EVENT } })
    )
  })

  it("keeps someone anonymous when they have no preferences row at all", async () => {
    // Everyone checked in before this table existed is in exactly this state
    // until the backfill runs, and the answer has to be "anonymous".
    mockDb.event_check_ins.findMany.mockResolvedValue([checkIn("legacy", DAY1)])
    mockDb.event_match_preferences.findMany.mockResolvedValue([])
    mockDb.chat_group_members.findMany.mockResolvedValue([
      { user_id: "legacy", anonymous_name: "Cosmic Panda" },
    ])

    const matches = await matchesForEvent(EVENT, VIEWER)
    expect(matches![0].displayName).toBe("Cosmic Panda")
    expect(JSON.stringify(matches)).not.toContain("Real Name")
  })

  it("still refuses someone who was never in the room", async () => {
    mockDb.event_check_ins.findFirst.mockResolvedValue(null)
    expect(await matchesForEvent(EVENT, VIEWER)).toBeNull()
    expect(mockDb.event_check_ins.findMany).not.toHaveBeenCalled()
  })
})
