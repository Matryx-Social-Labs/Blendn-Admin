/*
 * Leaving a match: mutual, soft, and one-way.
 *
 * The behaviour being replaced was a unilateral hard delete with a cascade, and
 * the reason it mattered is not sentimental. `message_reports.message_id`
 * carries no foreign key, so deleting a conversation left the report standing
 * with its evidence gone, and `resolveReport` then refused to suspend anyone
 * because it could not resolve an author. The delete button belonged to
 * whichever of the two was more motivated to erase the thread — which is the
 * person being reported.
 *
 * Every test here pins a rule that, if it broke, would fail silently: nothing
 * throws, no error surfaces, and the person who left simply stays reachable.
 */

const mockDb = {
  private_conversations: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    updateMany: jest.fn(),
  },
  event_likes: { findFirst: jest.fn(), findMany: jest.fn() },
  event_match_preferences: { findFirst: jest.fn(), findMany: jest.fn() },
  blocked_users: { findFirst: jest.fn(), findMany: jest.fn() },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))

import {
  ConversationClosedError,
  closeConversation,
  closedPairKeys,
  conversationPair,
  openConversation,
  pairIsClosed,
} from "@/lib/conversations"
import { maySeeIdentity } from "@/lib/identity"

const A = "aaaa"
const B = "bbbb"

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.private_conversations.findUnique.mockResolvedValue(null)
  mockDb.private_conversations.findMany.mockResolvedValue([])
  mockDb.private_conversations.upsert.mockResolvedValue({ id: "conv-1" })
  mockDb.private_conversations.updateMany.mockResolvedValue({ count: 1 })
})

describe("openConversation", () => {
  it("creates a live conversation in canonical order", async () => {
    await openConversation(B, A)

    const [u1, u2] = conversationPair(A, B)
    expect(mockDb.private_conversations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ user1_id: u1, user2_id: u2 }),
      })
    )
  })

  it("refuses a closed pair instead of handing back the closed row", async () => {
    /*
     * The keystone. The upsert was `update: {}`, which was fine while every row
     * was live and silently wrong once closing existed: a fresh mutual like
     * would get the CLOSED row back — a conversation that reads as live to the
     * caller, is invisible in both inboxes, and refuses every message sent to
     * it. Unmatching is permanent, so an error is the honest answer.
     */
    mockDb.private_conversations.findUnique.mockResolvedValue({
      id: "conv-1",
      closed_at: new Date(),
    })

    await expect(openConversation(A, B)).rejects.toBeInstanceOf(ConversationClosedError)
    expect(mockDb.private_conversations.upsert).not.toHaveBeenCalled()
  })

  it("returns an existing live conversation without rewriting it", async () => {
    // A pair who already talked through a message request and THEN match keep
    // the row they have: real names, no gating. Retro-anonymising a live
    // conversation would be absurd.
    mockDb.private_conversations.findUnique.mockResolvedValue({ id: "conv-1", closed_at: null })
    mockDb.private_conversations.findUniqueOrThrow.mockResolvedValue({ id: "conv-1" })

    const conv = await openConversation(A, B, { pseudonyms: { [A]: "Kestrel" } })

    expect(conv.id).toBe("conv-1")
    expect(mockDb.private_conversations.upsert).not.toHaveBeenCalled()
  })

  it("snapshots the pseudonyms rather than leaving them to a lookup", async () => {
    const [u1, u2] = conversationPair(A, B)
    await openConversation(A, B, {
      eventId: "event-1",
      pseudonyms: { [u1]: "Wandering Kestrel", [u2]: "Cosmic Panda" },
    })

    expect(mockDb.private_conversations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          origin_event_id: "event-1",
          user1_pseudonym: "Wandering Kestrel",
          user2_pseudonym: "Cosmic Panda",
        }),
      })
    )
  })

  it("seeds reveal true for a side already public in the room", async () => {
    /*
     * Someone who revealed in the room where the match happened has nothing
     * left to reveal to a person who saw their card — `revealed` is room-wide.
     * Pretending otherwise would be theatre.
     */
    const [u1] = conversationPair(A, B)
    await openConversation(A, B, { eventId: "event-1", revealed: [u1] })

    const create = mockDb.private_conversations.upsert.mock.calls[0][0].create
    expect(create.user1_revealed).toBe(true)
    expect(create.user2_revealed).toBe(false)
  })

  it("leaves both sides unrevealed and unnamed for a non-match conversation", async () => {
    // Message-request conversations pass no context and keep real names, as
    // they always have. Null pseudonyms are what signals that.
    await openConversation(A, B)

    const create = mockDb.private_conversations.upsert.mock.calls[0][0].create
    expect(create.user1_pseudonym).toBeNull()
    expect(create.user2_pseudonym).toBeNull()
    expect(create.user1_revealed).toBe(false)
    expect(create.user2_revealed).toBe(false)
  })
})

describe("closeConversation", () => {
  it("marks the row rather than deleting it", async () => {
    // Soft, because the person most motivated to erase a conversation is the
    // one being reported in it.
    await closeConversation("conv-1", A, "unmatch")

    expect(mockDb.private_conversations.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ closed_by: A, closed_reason: "unmatch" }),
      })
    )
  })

  it("is idempotent — a second close does not rewrite who left", async () => {
    // Scoped by `closed_at: null`, so a double tap or a client retry keeps the
    // first close. Otherwise the second caller becomes the recorded leaver.
    await closeConversation("conv-1", A, "unmatch")

    const where = mockDb.private_conversations.updateMany.mock.calls[0][0].where
    expect(where).toMatchObject({ id: "conv-1", closed_at: null })
  })

  it("records the reason without anything branching on it", async () => {
    await closeConversation("conv-1", A, "block")
    expect(
      mockDb.private_conversations.updateMany.mock.calls[0][0].data.closed_reason
    ).toBe("block")
  })
})

describe("pairIsClosed", () => {
  it("is direction-independent", async () => {
    mockDb.private_conversations.findUnique.mockResolvedValue({ closed_at: new Date() })

    expect(await pairIsClosed(A, B)).toBe(true)
    expect(await pairIsClosed(B, A)).toBe(true)
  })

  it("is false for a live pair and for strangers", async () => {
    mockDb.private_conversations.findUnique.mockResolvedValueOnce({ closed_at: null })
    expect(await pairIsClosed(A, B)).toBe(false)

    mockDb.private_conversations.findUnique.mockResolvedValueOnce(null)
    expect(await pairIsClosed(A, "never-met")).toBe(false)
  })
})

describe("closedPairKeys", () => {
  it("returns the OTHER user from each closed pair, whichever side you are", async () => {
    // Feeds the same `hidden` set as blocks in lib/matches.ts, so it has to be
    // the counterparty id, never your own.
    mockDb.private_conversations.findMany.mockResolvedValue([
      { user1_id: A, user2_id: B },
      { user1_id: "cccc", user2_id: A },
    ])

    const keys = await closedPairKeys(A)
    expect(keys).toEqual(new Set([B, "cccc"]))
    expect(keys.has(A)).toBe(false)
  })
})

describe("maySeeIdentity after leaving", () => {
  /*
   * These fixtures are **rows**, not per-call return values.
   *
   * They used to be `mockResolvedValueOnce` pairs against `findFirst`, which
   * meant each test encoded the order the five branches happened to run in —
   * so "no live conversation, but a closed one" was expressed as first-call
   * null, second-call a row. `maySeeIdentity` is now a wrapper over
   * `maySeeIdentityFor`, which reads open and closed in one query, and that
   * ordering stopped existing.
   *
   * Stating the rows instead says what is true of the database rather than what
   * the implementation asks for, and it is the reason the rewrite could keep
   * every assertion below intact.
   */
  const EVENT = "event-1"

  function given(rows: {
    likedByViewer?: boolean
    likedViewer?: boolean
    conversation?: "open" | "closed" | null
    theyRevealed?: boolean
    blocked?: "viewer" | "target" | null
  }) {
    mockDb.event_likes.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      "liker_id" in args.where && typeof args.where.liker_id === "string"
        ? rows.likedByViewer
          ? [{ event_id: EVENT, liked_id: B }]
          : []
        : rows.likedViewer
          ? [{ event_id: EVENT, liker_id: B }]
          : []
    )
    mockDb.private_conversations.findMany.mockResolvedValue(
      rows.conversation
        ? [
            {
              user1_id: A,
              user2_id: B,
              closed_at: rows.conversation === "closed" ? new Date() : null,
            },
          ]
        : []
    )
    mockDb.event_match_preferences.findMany.mockResolvedValue(
      rows.theyRevealed ? [{ user_id: B }] : []
    )
    /*
     * This mock honours the `where`, and the recorded control is why.
     *
     * It first returned the block row regardless of what was asked for, so
     * deleting one direction from the real query changed nothing here and the
     * symmetry test below passed against a one-directional gate — only the
     * structural assertion in `privacy-leaks.test.ts` caught it. A mock that
     * ignores its own predicate makes every test using it weaker than it reads,
     * and here it silently removed the half of "both directions" that the test
     * exists for.
     */
    const blockRows =
      rows.blocked === "viewer"
        ? [{ blocker_id: A, blocked_id: B }]
        : rows.blocked === "target"
          ? [{ blocker_id: B, blocked_id: A }]
          : []
    mockDb.blocked_users.findMany.mockImplementation(
      async (args: { where: { OR: Array<{ blocker_id: unknown; blocked_id: unknown }> } }) => {
        const matches = (row: { blocker_id: string; blocked_id: string }) =>
          args.where.OR.some((clause) => {
            const blockerOk =
              typeof clause.blocker_id === "string"
                ? clause.blocker_id === row.blocker_id
                : (clause.blocker_id as { in: string[] }).in.includes(row.blocker_id)
            const blockedOk =
              typeof clause.blocked_id === "string"
                ? clause.blocked_id === row.blocked_id
                : (clause.blocked_id as { in: string[] }).in.includes(row.blocked_id)
            return blockerOk && blockedOk
          })
        return blockRows.filter(matches)
      }
    )
  }

  beforeEach(() => {
    given({})
  })

  it("sees a live mutual match — the control for every negative below", async () => {
    /*
     * Added with the rewrite, because every other test here asserts `false`.
     * A `maySeeIdentityFor` that returned an empty set unconditionally — a
     * broken intersection, a fold that never adds anyone — would pass all five
     * of them and fail only this one.
     */
    given({ likedByViewer: true, likedViewer: true })
    expect(await maySeeIdentity(A, B)).toBe(true)
  })

  it("stops showing an identity once the pair has left each other", async () => {
    /*
     * The gap that would have made unmatching cosmetic.
     *
     * `event_likes` rows are never deleted, so the mutual-like branch stays
     * true forever, and someone public in a shared room stays public there. A
     * close therefore has to OVERRIDE both rather than sit beside them —
     * otherwise the other person keeps pulling your real name and photos from
     * GET /users/:id in the two most common ways of having met.
     */
    given({
      likedByViewer: true,
      likedViewer: true,
      theyRevealed: true,
      conversation: "closed",
    })

    expect(await maySeeIdentity(A, B)).toBe(false)
  })

  it("still shows an identity to a live mutual match", async () => {
    given({ likedByViewer: true, likedViewer: true, conversation: "open" })
    expect(await maySeeIdentity(A, B)).toBe(true)
  })

  it("always lets you see yourself", async () => {
    expect(await maySeeIdentity(A, A)).toBe(true)
  })

  it("asks for a LIVE conversation, not any conversation", async () => {
    /*
     * The predicate moved rather than disappearing. One query now returns both
     * states and `closed_at` is read in the fold, so what has to be pinned is
     * that a closed row is still *distinguished* — a fold that ignored
     * `closed_at` would make leaving cosmetic again, which is this file's
     * whole subject.
     */
    given({ likedByViewer: true, likedViewer: true, conversation: "closed" })
    expect(await maySeeIdentity(A, B)).toBe(false)

    given({ likedByViewer: true, likedViewer: true, conversation: "open" })
    expect(await maySeeIdentity(A, B)).toBe(true)
  })

  it("needs the like to be mutual AND at the same event", async () => {
    /*
     * The half a set-based intersection can get wrong that a correlated
     * subquery could not. `maySeeIdentityFor` fetches both directions and
     * intersects on `(event_id, other)`; an implementation that intersected on
     * the person alone would call two one-way likes at two different events a
     * match.
     */
    given({ likedByViewer: true })
    expect(await maySeeIdentity(A, B)).toBe(false)

    given({ likedViewer: true })
    expect(await maySeeIdentity(A, B)).toBe(false)

    mockDb.event_likes.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      typeof args.where.liker_id === "string"
        ? [{ event_id: "event-1", liked_id: B }]
        : [{ event_id: "event-2", liker_id: B }]
    )
    expect(await maySeeIdentity(A, B)).toBe(false)
  })

  it("lets a block override a mutual like with no conversation", async () => {
    /*
     * The case a close does not cover.
     *
     * Blocking closes the conversation, so the branch above already handled
     * pairs who had been talking. It did not handle the two ways of having met
     * that leave no conversation behind — a mutual like nobody has messaged,
     * and somebody who went public in a room you were both in. Both survive
     * forever, so blocking a person you had revealed to left them pulling your
     * real name and photographs from GET /users/:id indefinitely.
     *
     * Reveal is one-way and non-retractable by design. A block is the one way
     * to un-tell a single person, and it has to reach this gate to mean that.
     */
    given({
      likedByViewer: true,
      likedViewer: true,
      theyRevealed: true,
      blocked: "target",
    })

    expect(await maySeeIdentity(A, B)).toBe(false)
  })

  it("checks the block in both directions", async () => {
    /*
     * Symmetric on purpose: the person who blocked does not want to see, and
     * the person blocked must not be seen. A one-directional check would leave
     * whichever of those the implementer happened not to think of.
     *
     * Asserted behaviourally rather than by reading the `where` clause, which
     * is what this pinned before. A query-shape assertion passes against a fold
     * that fetches both directions and then acts on one.
     */
    given({ likedByViewer: true, likedViewer: true, blocked: "viewer" })
    expect(await maySeeIdentity(A, B)).toBe(false)

    given({ likedByViewer: true, likedViewer: true, blocked: "target" })
    expect(await maySeeIdentity(A, B)).toBe(false)
  })
})
