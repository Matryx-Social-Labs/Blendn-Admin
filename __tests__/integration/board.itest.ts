import { db, closeDb, makeUser, makeEvent, testId } from "./helpers"
import { cameFromMatch } from "@/lib/conversation-identity"
import { openConversation, conversationPair } from "@/lib/conversations"

/**
 * The board's invariants, against a real Postgres.
 *
 * Every one of these lives in migration SQL and **cannot be expressed in
 * `schema.prisma`** — a partial unique index and three CHECK constraints. A
 * `db push` database has none of them, so a suite that ran against one would
 * pass while the rules it describes were simply absent. That is not
 * hypothetical: `scripts/seed-qa.ts` created rows the deployed database
 * rejects, and passed locally for as long as it existed.
 */
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
    await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) {
    await db.private_conversations.deleteMany({
      where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] },
    })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

async function board() {
  const host = await makeUser(testId("bd-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)

  const author = await makeUser(testId("bd-author"))
  const asker = await makeUser(testId("bd-asker"))
  users.push(author, asker)

  const post = await db.board_posts.create({
    data: {
      event_id: eventId,
      author_id: author,
      kind: "offer",
      body: "Driving from Indiranagar, two seats",
      spaces_left: 2,
    },
    select: { id: true },
  })
  return { eventId, author, asker, postId: post.id }
}

describe("a post's shape is enforced by the database", () => {
  it("refuses spaces on a post that is not an offer", async () => {
    /*
     * `spaces_left` on a `seeking` post is meaningless — you cannot offer seats
     * in a car you are asking to ride in. Left to the application it would be
     * enforced in one route and forgotten in the next.
     */
    const { eventId, author } = await board()

    await expect(
      db.board_posts.create({
        data: { event_id: eventId, author_id: author, kind: "seeking", body: "x", spaces_left: 2 },
      })
    ).rejects.toThrow()
  })

  it("refuses negative spaces", async () => {
    const { eventId, author } = await board()

    await expect(
      db.board_posts.create({
        data: { event_id: eventId, author_id: author, kind: "offer", body: "x", spaces_left: -1 },
      })
    ).rejects.toThrow()
  })

  it("allows zero, which is a full car and not an absent one", async () => {
    // The reason the column is nullable rather than defaulted: "no spaces left"
    // and "this post was never about spaces" are different states, and a zero
    // default would render every chat post as a full car.
    const { eventId, author } = await board()

    const full = await db.board_posts.create({
      data: { event_id: eventId, author_id: author, kind: "offer", body: "full", spaces_left: 0 },
      select: { spaces_left: true },
    })
    expect(full.spaces_left).toBe(0)

    const chat = await db.board_posts.create({
      data: { event_id: eventId, author_id: author, kind: "chat", body: "anyone else nervous" },
      select: { spaces_left: true },
    })
    expect(chat.spaces_left).toBeNull()
  })
})

describe("a request cannot be sent twice", () => {
  it("refuses a second PENDING request to the same post", async () => {
    /*
     * The invariant that matters most. A double tap on a slow connection asks
     * the same person the same question twice — the pestering the outstanding
     * cap exists to prevent, arriving by accident rather than by persistence.
     */
    const { eventId, author, asker, postId } = await board()

    await db.board_requests.create({
      data: { event_id: eventId, post_id: postId, from_user_id: asker, to_user_id: author },
    })

    await expect(
      db.board_requests.create({
        data: { event_id: eventId, post_id: postId, from_user_id: asker, to_user_id: author },
      })
    ).rejects.toThrow()
  })

  it("allows a fresh ask once the first was decided", async () => {
    /*
     * Scoped to pending on purpose. Whether a declined request may be re-sent
     * is the cap's decision to make, not the database's — the index only stops
     * two live asks existing at once.
     */
    const { eventId, author, asker, postId } = await board()

    const first = await db.board_requests.create({
      data: { event_id: eventId, post_id: postId, from_user_id: asker, to_user_id: author },
      select: { id: true },
    })
    await db.board_requests.update({
      where: { id: first.id },
      data: { status: "declined", decided_at: new Date() },
    })

    const second = await db.board_requests.create({
      data: { event_id: eventId, post_id: postId, from_user_id: asker, to_user_id: author },
      select: { status: true },
    })
    expect(second.status).toBe("pending")
  })

  it("refuses answering your own post", async () => {
    // Not a request, a typo.
    const { eventId, author, postId } = await board()

    await expect(
      db.board_requests.create({
        data: { event_id: eventId, post_id: postId, from_user_id: author, to_user_id: author },
      })
    ).rejects.toThrow()
  })
})

describe("a decision has a time", () => {
  it("refuses a decided request with no decided_at", async () => {
    /*
     * Without this, "accepted" rows with no timestamp accumulate and any
     * question about response time becomes unanswerable — which is the first
     * thing anybody asks of a feature about whether people answer each other.
     */
    const { eventId, author, asker, postId } = await board()
    const r = await db.board_requests.create({
      data: { event_id: eventId, post_id: postId, from_user_id: asker, to_user_id: author },
      select: { id: true },
    })

    await expect(
      db.board_requests.update({ where: { id: r.id }, data: { status: "accepted" } })
    ).rejects.toThrow()
  })

  it("refuses a pending request that claims one", async () => {
    const { eventId, author, asker, postId } = await board()

    await expect(
      db.board_requests.create({
        data: {
          event_id: eventId,
          post_id: postId,
          from_user_id: asker,
          to_user_id: author,
          decided_at: new Date(),
        },
      })
    ).rejects.toThrow()
  })
})

describe("accepting opens a conversation the app can tell from a match", () => {
  it("stores the origin, so a board conversation is not read as a match", async () => {
    /*
     * The bug this column exists for, end to end.
     *
     * A board conversation has to be pseudonymous — see below — and so does a
     * match, so `cameFromMatch`'s pseudonym test answers `true` for both. The
     * client draws the match opener on anything it answers true for, so two
     * people who agreed to share a car would be told they liked each other.
     *
     * Against real Postgres rather than a mock, because the whole assertion is
     * that a column written by one module is read correctly by another.
     */
    const { eventId, author, asker, postId } = await board()

    const request = await db.board_requests.create({
      data: {
        event_id: eventId,
        post_id: postId,
        from_user_id: asker,
        to_user_id: author,
        status: "accepted",
        decided_at: new Date(),
      },
      select: { id: true },
    })

    await openConversation(asker, author, {
      eventId,
      pseudonyms: { [asker]: "Wry Otter", [author]: "Cosmic Panda" },
      boardRequestId: request.id,
    })

    const [user1_id, user2_id] = conversationPair(asker, author)
    const conversation = await db.private_conversations.findUniqueOrThrow({
      where: { user1_id_user2_id: { user1_id, user2_id } },
    })

    expect(conversation.origin_board_request_id).toBe(request.id)
    expect(conversation.origin_event_id).toBe(eventId)

    // Both pseudonyms present -- so the old rule would have said "match".
    expect(conversation.user1_pseudonym).not.toBeNull()
    expect(conversation.user2_pseudonym).not.toBeNull()
    expect(cameFromMatch(conversation)).toBe(false)
  })

  it("is pseudonymous, because the fallback is the real name", async () => {
    /*
     * NEGATIVE CONTROL (behavioural, recorded here rather than in the registry):
     * dropping `pseudonyms` from the accept path leaves both columns null, and
     * `displayNameInConversation` returns the real name when there is no
     * pseudonym -- so the two people see each other's names at the moment of
     * acceptance. Observed: this assertion fails, and `cameFromMatch` starts
     * answering `false` for the wrong reason, which is why both are asserted
     * above rather than only the second.
     */
    const { eventId, author, asker, postId } = await board()

    const request = await db.board_requests.create({
      data: {
        event_id: eventId,
        post_id: postId,
        from_user_id: asker,
        to_user_id: author,
        status: "accepted",
        decided_at: new Date(),
      },
      select: { id: true },
    })

    await openConversation(asker, author, {
      eventId,
      pseudonyms: { [asker]: "Wry Otter", [author]: "Cosmic Panda" },
      boardRequestId: request.id,
    })

    const [user1_id, user2_id] = conversationPair(asker, author)
    const conversation = await db.private_conversations.findUniqueOrThrow({
      where: { user1_id_user2_id: { user1_id, user2_id } },
    })

    expect([conversation.user1_pseudonym, conversation.user2_pseudonym].sort()).toEqual([
      "Cosmic Panda",
      "Wry Otter",
    ])
  })
})
