/**
 * A room handle is answered in its own room's terms.
 *
 * Reproduced on staging, 2026-09-28: an attendee revealed at two events the
 * viewer also attended (A and B) and stayed anonymous at a third (C). C's
 * roster showed her pseudonym, and the profile opened from that card — by C's
 * handle — returned her name and photos, because the gate asked "may the
 * viewer know who she is anywhere" and A said yes.
 *
 * These drive `identityForRef` and `maySeeIdentityFor` over an in-memory
 * stand-in for the six reads the gate makes. The same case runs against a real
 * database, through the routes, in `integration/room-scoped-identity.itest.ts`.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "unit-identity-room-scope-secret-32-characters"

type Where = Record<string, unknown>

const state = {
  checkIns: [] as { event_id: string; user_id: string }[],
  revealed: [] as { event_id: string; user_id: string }[],
  likes: [] as { event_id: string; liker_id: string; liked_id: string }[],
  conversations: [] as { user1_id: string; user2_id: string; closed_at: Date | null; origin_friendship: boolean }[],
  blocks: [] as { blocker_id: string; blocked_id: string }[],
  friendships: [] as { user1_id: string; user2_id: string }[],
  /** Who turned on `friends_see_me_in_rooms`. */
  optedIn: [] as string[],
}

const inList = (value: string, filter: unknown) => (filter as { in: string[] }).in.includes(value)

const mockDb = {
  event_check_ins: {
    findFirst: jest.fn(async ({ where }: { where: { event_id: string; user_id: string } }) =>
      state.checkIns.find((c) => c.event_id === where.event_id && c.user_id === where.user_id) ? { id: "ci" } : null
    ),
    findMany: jest.fn(async ({ where }: { where: { event_id: string; user_id: unknown } }) =>
      state.checkIns
        .filter((c) => c.event_id === where.event_id && inList(c.user_id, where.user_id))
        .map((c) => ({ user_id: c.user_id }))
    ),
  },
  event_match_preferences: {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      state.revealed
        .filter((r) => inList(r.user_id, where.user_id))
        .filter((r) =>
          // Scoped: one event. Unscoped: any event the viewer checked into.
          typeof where.event_id === "string"
            ? r.event_id === where.event_id
            : state.checkIns.some(
                (c) =>
                  c.event_id === r.event_id &&
                  c.user_id ===
                    (where.event as { check_ins: { some: { user_id: string } } }).check_ins.some.user_id
              )
        )
        .map((r) => ({ user_id: r.user_id }))
    ),
  },
  event_likes: {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      state.likes.filter((l) =>
        typeof where.liker_id === "string"
          ? l.liker_id === where.liker_id && inList(l.liked_id, where.liked_id)
          : l.liked_id === where.liked_id && inList(l.liker_id, where.liker_id)
      )
    ),
  },
  private_conversations: {
    // The room read asks only for closed ones; the unscoped read for all.
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      state.conversations.filter((c) => !("closed_at" in where) || c.closed_at !== null)
    ),
  },
  blocked_users: { findMany: jest.fn(async () => state.blocks) },
  friendships: {
    /*
     * The room read selects both people's switches and decides the direction
     * itself; the unscoped read filters on the other person's switch in SQL,
     * which is reproduced here for the viewer it names.
     */
    findMany: jest.fn(async ({ where, select }: { where: { OR: Where[] }; select: Where }) => {
      const flag = (id: string) => ({ profile: { friends_see_me_in_rooms: state.optedIn.includes(id) } })
      if ("user1" in select) return state.friendships.map((f) => ({ ...f, user1: flag(f.user1_id), user2: flag(f.user2_id) }))
      const viewer = where.OR[0].user1_id as string
      return state.friendships.filter((f) =>
        f.user1_id === viewer ? state.optedIn.includes(f.user2_id) : f.user2_id === viewer && state.optedIn.includes(f.user1_id)
      )
    }),
  },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

import {
  identityForRef,
  maySeeIdentityFor,
  recognisedInRoomBy,
  userIdFromRefIfIdentified,
  visibleInRoom,
} from "@/lib/identity"
import { roomHandle } from "@/lib/room-handle"

const A = "aaaaaaaa-0000-4000-8000-00000000000a"
const B = "bbbbbbbb-0000-4000-8000-00000000000b"
const C = "cccccccc-0000-4000-8000-00000000000c"
const VIEWER = "viewer"
const TANVI = "tanvi"

beforeEach(() => {
  jest.clearAllMocks()
  // The staging case: both at all three; she revealed at A and B, not at C,
  // and liked the viewer at A without it being returned.
  state.checkIns = [A, B, C].flatMap((e) => [
    { event_id: e, user_id: VIEWER },
    { event_id: e, user_id: TANVI },
  ])
  state.revealed = [
    { event_id: A, user_id: TANVI },
    { event_id: B, user_id: TANVI },
  ]
  state.likes = [{ event_id: A, liker_id: TANVI, liked_id: VIEWER }]
  state.conversations = []
  state.blocks = []
  state.friendships = []
  state.optedIn = []
})

describe("the staging case: revealed at A and B, anonymous at C", () => {
  it("C's handle does not identify her", async () => {
    expect(await identityForRef(VIEWER, roomHandle(C, TANVI))).toEqual({ userId: TANVI, room: C, identified: false })
  })

  it("A's handle does — she chose to be named in that room", async () => {
    expect(await identityForRef(VIEWER, roomHandle(A, TANVI))).toEqual({ userId: TANVI, room: A, identified: true })
  })

  it("her raw id keeps the unscoped answer, which a reveal anywhere shared satisfies", async () => {
    expect(await identityForRef(VIEWER, TANVI)).toEqual({ userId: TANVI, room: null, identified: true })
  })

  it("the scoped read asks for exactly that event, not any the viewer attended", async () => {
    await identityForRef(VIEWER, roomHandle(C, TANVI))
    expect(mockDb.event_match_preferences.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ event_id: C, revealed: true }) })
    )
  })

  it("the friends routes' resolver answers C's handle as a stranger's", async () => {
    const ref = roomHandle(C, TANVI)
    expect(await userIdFromRefIfIdentified(VIEWER, ref)).toBe(ref)
    expect(await userIdFromRefIfIdentified(VIEWER, roomHandle(A, TANVI))).toBe(TANVI)
  })
})

describe("in a room's terms, only what that room shows", () => {
  it("a mutual like at another event does not name her in C", async () => {
    state.revealed = []
    state.likes.push({ event_id: A, liker_id: VIEWER, liked_id: TANVI })
    expect((await maySeeIdentityFor(VIEWER, [TANVI])).has(TANVI)).toBe(true)
    expect((await maySeeIdentityFor(VIEWER, [TANVI], { room: C })).has(TANVI)).toBe(false)
    // Nor in A itself: the roster names people who revealed, not matches.
    expect((await maySeeIdentityFor(VIEWER, [TANVI], { room: A })).has(TANVI)).toBe(false)
  })

  it("an open conversation does not name her in a room either", async () => {
    state.revealed = []
    state.conversations = [{ user1_id: TANVI, user2_id: VIEWER, closed_at: null, origin_friendship: false }]
    expect((await maySeeIdentityFor(VIEWER, [TANVI])).has(TANVI)).toBe(true)
    expect((await maySeeIdentityFor(VIEWER, [TANVI], { room: C })).has(TANVI)).toBe(false)
  })

  it("a friend who lets friends recognise them in rooms is recognised in every room", async () => {
    // Their own standing consent — `friends_see_me_in_rooms` — not a fact
    // imported from another room.
    state.revealed = []
    state.friendships = [{ user1_id: TANVI, user2_id: VIEWER }]
    state.optedIn = [TANVI]
    expect((await maySeeIdentityFor(VIEWER, [TANVI], { room: C })).has(TANVI)).toBe(true)
  })

  it("a reveal in the room is not seen by somebody who was never in it", async () => {
    // A handle can reach a non-attendee (the interest counter room hands them
    // out); the roster would refuse that viewer, so this does too.
    state.checkIns = state.checkIns.filter((c) => !(c.event_id === A && c.user_id === VIEWER))
    expect(await identityForRef(VIEWER, roomHandle(A, TANVI))).toMatchObject({ identified: false })
  })

  it("a block beats a reveal in the room", async () => {
    state.blocks = [{ blocker_id: TANVI, blocked_id: VIEWER }]
    expect(await identityForRef(VIEWER, roomHandle(A, TANVI))).toMatchObject({ identified: false })
  })

  it("your own handle is you", async () => {
    expect(await identityForRef(VIEWER, roomHandle(C, VIEWER))).toEqual({ userId: VIEWER, room: C, identified: true })
    expect(mockDb.event_match_preferences.findMany).not.toHaveBeenCalled()
  })

  it("a forged handle is answered as the unknown id it is", async () => {
    const real = roomHandle(A, TANVI)
    const forged = real.slice(0, -2) + (real.endsWith("AA") ? "AB" : "AA")
    expect(await identityForRef(VIEWER, forged)).toEqual({ userId: forged, room: null, identified: false })
  })
})

/*
 * The roster's rule is the profile's rule (the friend switch, SCRUM follow-up
 * to #498). The roster read only the reveal; the profile a card opens also
 * honoured `friends_see_me_in_rooms`. So an opted-in friend was a pseudonym on
 * the list and named one tap later. Every room surface now asks `visibleInRoom`
 * (or `recognisedInRoomBy`, the same pairs the other way round), and these pin
 * that the two directions and the handle gate give one answer.
 */
describe("one rule for every room surface: revealed here, or an opted-in friend", () => {
  const FRIEND = "friend"
  const SHY = "shy-friend"
  const STRANGER = "stranger"

  beforeEach(() => {
    state.revealed = []
    state.likes = []
    state.checkIns = [VIEWER, FRIEND, SHY, STRANGER, TANVI].map((u) => ({ event_id: C, user_id: u }))
    state.friendships = [
      { user1_id: FRIEND, user2_id: VIEWER },
      { user1_id: SHY, user2_id: VIEWER },
    ]
    state.optedIn = [FRIEND]
  })

  const room = () => visibleInRoom(VIEWER, C, [FRIEND, SHY, STRANGER, TANVI])
  const gate = async (who: string) => (await identityForRef(VIEWER, roomHandle(C, who))).identified

  it("names an opted-in friend, on the list and on the profile alike", async () => {
    expect((await room()).has(FRIEND)).toBe(true)
    expect(await gate(FRIEND)).toBe(true)
  })

  it("keeps a friend who left the switch off a pseudonym, on both", async () => {
    expect((await room()).has(SHY)).toBe(false)
    expect(await gate(SHY)).toBe(false)
  })

  it("keeps a stranger a pseudonym unless they revealed at THIS event", async () => {
    expect((await room()).has(STRANGER)).toBe(false)
    state.revealed = [{ event_id: A, user_id: STRANGER }]
    expect((await room()).has(STRANGER)).toBe(false)
    state.revealed = [{ event_id: C, user_id: STRANGER }]
    expect((await room()).has(STRANGER)).toBe(true)
    expect(await gate(STRANGER)).toBe(true)
  })

  it("the switch is the target's: the viewer turning it on names nobody to the viewer", async () => {
    state.optedIn = [VIEWER]
    expect((await room()).has(FRIEND)).toBe(false)
  })

  it("a block either way beats the friend switch", async () => {
    for (const block of [
      { blocker_id: FRIEND, blocked_id: VIEWER },
      { blocker_id: VIEWER, blocked_id: FRIEND },
    ]) {
      state.blocks = [block]
      expect((await room()).has(FRIEND)).toBe(false)
      expect(await gate(FRIEND)).toBe(false)
    }
  })

  it("a closed conversation beats both the friend switch and a reveal here", async () => {
    state.revealed = [{ event_id: C, user_id: FRIEND }]
    state.conversations = [{ user1_id: VIEWER, user2_id: FRIEND, closed_at: new Date(), origin_friendship: true }]
    expect((await room()).has(FRIEND)).toBe(false)
    expect(await gate(FRIEND)).toBe(false)
  })

  it("an open conversation is not a room branch, for a friend with the switch off", async () => {
    state.conversations = [{ user1_id: VIEWER, user2_id: SHY, closed_at: null, origin_friendship: false }]
    expect((await room()).has(SHY)).toBe(false)
  })

  it("nobody who was never in the room recognises anybody in it", async () => {
    state.checkIns = state.checkIns.filter((c) => c.user_id !== VIEWER)
    expect((await room()).size).toBe(0)
  })

  it("asked the other way round (who recognises the arriver), the answer is the same pairs", async () => {
    // FRIEND arrives. Viewers: the one friend, a stranger, and FRIEND's own socket.
    state.friendships.push({ user1_id: FRIEND, user2_id: STRANGER })
    state.blocks = [{ blocker_id: STRANGER, blocked_id: FRIEND }]
    const seers = await recognisedInRoomBy(C, FRIEND, [VIEWER, STRANGER, TANVI, FRIEND])
    expect([...seers].sort()).toEqual([FRIEND, VIEWER].sort())
    for (const v of [VIEWER, STRANGER, TANVI]) {
      expect(seers.has(v)).toBe((await visibleInRoom(v, C, [FRIEND])).has(FRIEND))
    }
  })
})
