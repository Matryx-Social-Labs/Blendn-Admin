/**
 * Polls.
 *
 * The disclosure cases are the substance. `lib/disclosure.ts` has its own unit
 * tests and passed all of them while having no caller at all — the rule was
 * correct and unreachable, which protects nobody. These assert it is actually
 * applied on the path a phone reads.
 */

const mockDb = {
  events: { findUnique: jest.fn() },
  organisation_members: { findMany: jest.fn() },
  organisations: { findFirst: jest.fn() },
  chat_messages: { create: jest.fn() },
  chat_groups: { update: jest.fn() },
  chat_group_members: { findFirst: jest.fn() },
  chat_polls: { create: jest.fn(), findUnique: jest.fn() },
  chat_poll_votes: { groupBy: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
  $transaction: jest.fn(),
}

const mockAuth = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))

mockDb.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockDb))

import { SPONSORSHIP } from "@/lib/constants"
import { castVote, createPoll, getPollResults } from "@/lib/poll-actions"

const EVENT = "11111111-1111-4111-8111-111111111111"
const GROUP = "22222222-2222-4222-8222-222222222222"
const POLL = "33333333-3333-4333-8333-333333333333"
const ORG = "44444444-4444-4444-8444-444444444444"
const USER = "user-1"

const NOW = Date.now()
const HOUR = 60 * 60 * 1000

function optionRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `option-${i}`,
    label: `Option ${i}`,
    position: i,
  }))
}

/** A closed poll whose options have exactly these vote counts. */
function pollWith(counts: number[], over: Record<string, unknown> = {}) {
  mockDb.chat_polls.findUnique.mockResolvedValue({
    id: POLL,
    question: "How is the music?",
    closes_at: new Date(NOW - HOUR),
    results_visible: false,
    options: optionRows(counts.length),
    ...over,
  })
  mockDb.chat_poll_votes.groupBy.mockResolvedValue(
    counts.map((n, i) => ({ option_id: `option-${i}`, _count: { _all: n } }))
  )
  mockDb.chat_poll_votes.findUnique.mockResolvedValue(null)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockDb))
  mockAuth.mockResolvedValue({ user: { id: USER, role: "organizer" } })
  mockDb.organisation_members.findMany.mockResolvedValue([{ org_id: ORG }])
  mockDb.events.findUnique.mockResolvedValue({
    id: EVENT,
    start_time: new Date(NOW - HOUR),
    end_time: new Date(NOW + 3 * HOUR),
    organizer_org_id: ORG,
    venue: null,
    chat_group: { id: GROUP, status: "active" },
  })
  mockDb.chat_messages.create.mockResolvedValue({ id: "message-1", created_at: new Date(NOW) })
  mockDb.chat_polls.create.mockResolvedValue({ id: POLL })
})

describe("disclosure is actually applied", () => {
  it("hides a cell under the floor AND the total with it", async () => {
    // The subtraction leak: 142 - 98 - 41 recovers the 3.
    pollWith([98, 41, 3])

    const results = await getPollResults(POLL)

    expect(results.options.map((o) => o.votes)).toEqual([98, 41, null])
    expect(results.total).toBeNull()
    expect(results.suppressed).toBe(true)
    expect(results.suppressedLabel).toBeTruthy()
  })

  it("hides a lone survivor, because it is the complement", async () => {
    // 45 total, one option at 42 and one at 3. Hiding the 3 alone leaves the 42
    // standing, and the 42 IS the answer.
    pollWith([42, 3])

    const results = await getPollResults(POLL)

    expect(results.options.map((o) => o.votes)).toEqual([null, null])
    expect(results.total).toBeNull()
  })

  it("publishes everything once every option clears the floor", async () => {
    pollWith([12, 9, 7])

    const results = await getPollResults(POLL)

    expect(results.options.map((o) => o.votes)).toEqual([12, 9, 7])
    expect(results.total).toBe(28)
    expect(results.suppressed).toBe(false)
    expect(results.suppressedLabel).toBeNull()
  })

  it("withholds a cell exactly at the floor minus one", async () => {
    const floor = SPONSORSHIP.MIN_REPORTABLE
    pollWith([20, floor, floor - 1])

    const results = await getPollResults(POLL)

    expect(results.options[1].votes).toBe(floor)
    expect(results.options[2].votes).toBeNull()
  })

  it("never reports zero as a number", async () => {
    /*
     * `null` and `0` are different claims and only one of them is safe. An
     * option nobody picked in a room of thirty is still under the floor, so it
     * is withheld rather than published as a public zero.
     */
    pollWith([30, 0])

    const results = await getPollResults(POLL)

    expect(results.options[1].votes).toBeNull()
    expect(results.options.map((o) => o.votes)).not.toContain(0)
  })
})

describe("results before close", () => {
  it("returns nothing at all while the poll is open", async () => {
    pollWith([98, 41, 12], { closes_at: new Date(NOW + HOUR), results_visible: false })

    const results = await getPollResults(POLL)

    /*
     * Not the numbers blurred — the absence IS the protection. A running total
     * biases later voters, and streaming counts is a timing oracle: in a room of
     * four everyone watching sees 0 → 1 the moment somebody votes.
     */
    expect(results.closed).toBe(false)
    expect(results.options.map((o) => o.votes)).toEqual([null, null, null])
    expect(results.total).toBeNull()
    expect(results.suppressedLabel).toMatch(/when the poll closes/)
  })

  it("publishes early only when the poll opted in, and still applies the floor", async () => {
    pollWith([98, 41, 3], { closes_at: new Date(NOW + HOUR), results_visible: true })

    const results = await getPollResults(POLL)

    expect(results.closed).toBe(false)
    expect(results.options.map((o) => o.votes)).toEqual([98, 41, null])
    expect(results.total).toBeNull()
  })

  it("reports the reader's own vote whatever the counts say", async () => {
    // Their own choice is not somebody else's data, and hiding it would make the
    // UI unable to show what they picked.
    pollWith([98, 41, 3], { closes_at: new Date(NOW + HOUR), results_visible: false })
    mockDb.chat_poll_votes.findUnique.mockResolvedValue({ option_id: "option-2" })

    const results = await getPollResults(POLL, USER)

    expect(results.myVote).toBe("option-2")
    expect(results.options.map((o) => o.votes)).toEqual([null, null, null])
  })
})

describe("creating a poll", () => {
  it("defaults to closing at the end of the event, not the end of the room", async () => {
    await createPoll(EVENT, { question: "How is the music?", options: ["Great", "Loud"] })

    const closes = mockDb.chat_polls.create.mock.calls[0][0].data.closes_at
    /*
     * The room opens before doors and stays open for a feedback window after. A
     * poll that "closes with the room" keeps collecting votes for a day from
     * people who have gone home.
     */
    expect(closes).toEqual(new Date(NOW + 3 * HOUR))
  })

  it("refuses a closing time past the event", async () => {
    await expect(
      createPoll(EVENT, {
        question: "How is the music?",
        options: ["Great", "Loud"],
        closesAt: new Date(NOW + 30 * HOUR),
      })
    ).rejects.toThrow(/cannot outlast/i)
  })

  it("posts into the transcript as a message, not a parallel feed", async () => {
    await createPoll(EVENT, { question: "How is the music?", options: ["Great", "Loud"] })

    const data = mockDb.chat_messages.create.mock.calls[0][0].data
    expect(data.type).toBe("poll")
    // The question doubles as the body so search, moderation and a client that
    // does not know the type yet all show something meaningful.
    expect(data.content).toBe("How is the music?")
    expect(mockDb.chat_groups.update).toHaveBeenCalledTimes(1)
  })

  it("hides results by default", async () => {
    await createPoll(EVENT, { question: "How is the music?", options: ["Great", "Loud"] })

    expect(mockDb.chat_polls.create.mock.calls[0][0].data.results_visible).toBe(false)
  })

  it("refuses two options that say the same thing", async () => {
    await expect(
      createPoll(EVENT, { question: "How is the music?", options: ["Great", "great"] })
    ).rejects.toThrow(/same thing/i)
  })

  it("refuses fewer than two options", async () => {
    await expect(
      createPoll(EVENT, { question: "How is the music?", options: ["Great"] })
    ).rejects.toThrow(/at least two/i)
  })

  it("refuses a closed room", async () => {
    mockDb.events.findUnique.mockResolvedValue({
      id: EVENT,
      start_time: new Date(NOW - HOUR),
      end_time: new Date(NOW + 3 * HOUR),
      organizer_org_id: ORG,
      venue: null,
      chat_group: { id: GROUP, status: "archived" },
    })

    await expect(
      createPoll(EVENT, { question: "How is the music?", options: ["Great", "Loud"] })
    ).rejects.toThrow(/not open/i)
  })

  it("gates a sponsored poll on the sponsor grant, not on canOperate", async () => {
    /*
     * A poll from a brand carries that brand's name into the room and takes the
     * same attention as any sponsored message. Gating it more weakly because the
     * payload happens to be a question is how the label stops meaning anything.
     */
    mockDb.organisations.findFirst.mockResolvedValue(null)

    await expect(
      createPoll(EVENT, {
        question: "Which flavour?",
        options: ["Original", "Sugarfree"],
        kind: "sponsored",
      })
    ).rejects.toThrow(/forbidden/i)

    expect(mockDb.chat_polls.create).not.toHaveBeenCalled()
  })

  it("allows a sponsored poll once the grant resolves", async () => {
    mockDb.organisations.findFirst.mockResolvedValue({ id: ORG })

    await createPoll(EVENT, {
      question: "Which flavour?",
      options: ["Original", "Sugarfree"],
      kind: "sponsored",
    })

    expect(mockDb.chat_polls.create).toHaveBeenCalledTimes(1)
  })
})

describe("voting", () => {
  function votable(over: Record<string, unknown> = {}) {
    mockDb.chat_polls.findUnique.mockResolvedValue({
      id: POLL,
      closes_at: new Date(NOW + HOUR),
      options: [{ id: "option-0" }],
      message: {
        chat_group_id: GROUP,
        deleted_at: null,
        chat_group: {
          id: GROUP,
          status: "active",
          event: { start_time: new Date(NOW - HOUR), end_time: new Date(NOW + 3 * HOUR) },
        },
      },
      ...over,
    })
    mockDb.chat_group_members.findFirst.mockResolvedValue({ id: "member-1" })
  }

  it("upserts, so one person cannot stack votes", async () => {
    votable()

    await castVote(POLL, "option-0", USER)

    // The unique on (poll_id, user_id) makes this a database fact. An insert
    // would raise instead, and a misclick would be permanent.
    expect(mockDb.chat_poll_votes.upsert).toHaveBeenCalledTimes(1)
    expect(mockDb.chat_poll_votes.upsert.mock.calls[0][0].where.poll_id_user_id).toEqual({
      poll_id: POLL,
      user_id: USER,
    })
  })

  it("refuses a closed poll", async () => {
    votable({ closes_at: new Date(NOW - HOUR) })

    await expect(castVote(POLL, "option-0", USER)).rejects.toThrow(/closed/i)
    expect(mockDb.chat_poll_votes.upsert).not.toHaveBeenCalled()
  })

  it("refuses an option belonging to another poll", async () => {
    // The composite foreign key would reject it, but a 500 from a constraint
    // violation is not an answer anybody can act on.
    votable({ options: [] })

    await expect(castVote(POLL, "option-99", USER)).rejects.toThrow(/not an option/i)
    expect(mockDb.chat_poll_votes.upsert).not.toHaveBeenCalled()
  })

  it("refuses somebody who is not in the room", async () => {
    votable()
    mockDb.chat_group_members.findFirst.mockResolvedValue(null)

    await expect(castVote(POLL, "option-0", USER)).rejects.toThrow(/not in this chatroom/i)
    expect(mockDb.chat_poll_votes.upsert).not.toHaveBeenCalled()
  })

  it("counts a muted member as present, and somebody who left as absent", async () => {
    votable()
    await castVote(POLL, "option-0", USER)

    const where = mockDb.chat_group_members.findFirst.mock.calls[0][0].where
    // A muted member still reads the room, and a poll is not speech. Someone who
    // left is not a participant — their row is kept only for the pseudonym.
    expect(where.status).toEqual({ in: ["active", "muted"] })
  })

  it("refuses a vote on a deleted message", async () => {
    votable({ message: { chat_group_id: GROUP, deleted_at: new Date(), chat_group: null } })

    await expect(castVote(POLL, "option-0", USER)).rejects.toThrow(/not found/i)
  })
})
