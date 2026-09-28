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
  friendsOptedIn: [] as { user1_id: string; user2_id: string }[],
}

const inList = (value: string, filter: unknown) => (filter as { in: string[] }).in.includes(value)

const mockDb = {
  event_check_ins: {
    findFirst: jest.fn(async ({ where }: { where: { event_id: string; user_id: string } }) =>
      state.checkIns.find((c) => c.event_id === where.event_id && c.user_id === where.user_id) ? { id: "ci" } : null
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
  private_conversations: { findMany: jest.fn(async () => state.conversations) },
  blocked_users: { findMany: jest.fn(async () => state.blocks) },
  friendships: { findMany: jest.fn(async () => state.friendsOptedIn) },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

import { identityForRef, maySeeIdentityFor, userIdFromRefIfIdentified } from "@/lib/identity"
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
  state.friendsOptedIn = []
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
    state.friendsOptedIn = [{ user1_id: TANVI, user2_id: VIEWER }]
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
