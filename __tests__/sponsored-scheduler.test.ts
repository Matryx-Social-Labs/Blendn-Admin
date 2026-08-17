import { readFileSync } from "fs"
import { join } from "path"

/**
 * The sponsored scheduler.
 *
 * Every case here is something the `setInterval` version got wrong in
 * production. The order of operations is the substance: a message that exists
 * with no outbox row behind it is a message that will be sent again after the
 * next restart, in a room where the brand is the only named participant.
 */

process.env.NEXTAUTH_SECRET = "test-secret-that-is-at-least-32-chars-long"

const mockDb = {
  $queryRaw: jest.fn(),
  events: { findUnique: jest.fn() },
  chat_groups: { update: jest.fn() },
  chat_messages: { create: jest.fn() },
  chat_group_members: { findMany: jest.fn() },
  sponsored_creatives: { findFirst: jest.fn() },
  sponsored_message_sends: { findFirst: jest.fn(), createMany: jest.fn(), update: jest.fn() },
  event_sponsored_messages: { updateMany: jest.fn() },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/socket-server", () => ({
  emitChatMessage: jest.fn(),
  socketsInChatRoom: jest.fn().mockResolvedValue(3),
}))

import { SPONSORSHIP } from "@/lib/constants"
import { firstWindow, sweepSponsored } from "@/lib/sponsored-scheduler"

const NOW = new Date("2026-08-17T20:00:00.000Z")
const CAMPAIGN = "11111111-1111-4111-8111-111111111111"
const EVENT = "22222222-2222-4222-8222-222222222222"
const GROUP = "33333333-3333-4333-8333-333333333333"

/** Due ten minutes ago, so `next_send_at` and `now` are distinguishable. */
const SCHEDULED = new Date("2026-08-17T19:50:00.000Z")

const claimed = (over: Record<string, unknown> = {}) => [
  {
    id: CAMPAIGN,
    event_id: EVENT,
    content: "Stay hydrated",
    interval_minutes: 30,
    sponsor_id: "44444444-4444-4444-8444-444444444444",
    scheduled_for: SCHEDULED,
    consecutive_failures: 0,
    ...over,
  },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.$queryRaw.mockResolvedValue(claimed())
  mockDb.events.findUnique.mockResolvedValue({
    // Started an hour ago, ends in two: the room is open.
    start_time: new Date("2026-08-17T19:00:00.000Z"),
    end_time: new Date("2026-08-17T22:00:00.000Z"),
    organizer_id: "organiser-1",
    chat_group: { id: GROUP, status: "active" },
  })
  mockDb.sponsored_message_sends.findFirst.mockResolvedValue(null)
  mockDb.sponsored_creatives.findFirst.mockResolvedValue({
    id: "creative-1",
    content: "Stay hydrated",
    media_url: null,
  })
  mockDb.chat_group_members.findMany.mockResolvedValue([
    { user_id: "user-a" },
    { user_id: "user-b" },
  ])
  mockDb.sponsored_message_sends.createMany.mockResolvedValue({ count: 1 })
  mockDb.chat_messages.create.mockResolvedValue({
    id: "message-1",
    content: "📣 [Sponsored]\nStay hydrated",
    created_at: NOW,
  })
})

describe("the happy path", () => {
  it("records the window before it posts anything", async () => {
    const order: string[] = []
    mockDb.sponsored_message_sends.createMany.mockImplementation(async () => {
      order.push("outbox")
      return { count: 1 }
    })
    mockDb.chat_messages.create.mockImplementation(async () => {
      order.push("post")
      return { id: "message-1", content: "x", created_at: NOW }
    })

    const result = await sweepSponsored(NOW)

    /*
     * Outbox first, always. The other order is what made a crash mid-send
     * unrecoverable: with the message already in the room and no row saying the
     * window ran, the next pass sent it again.
     */
    expect(order).toEqual(["outbox", "post"])
    expect(result.sent).toBe(1)
  })

  it("inserts the outbox row against the claimed window, not against now", async () => {
    await sweepSponsored(NOW)

    const row = mockDb.sponsored_message_sends.createMany.mock.calls[0][0].data[0]
    // `scheduled_for` is half of the unique that makes a retry a no-op. Using
    // `now` would make every retry a distinct window and defeat it entirely.
    expect(row.scheduled_for).toBe(SCHEDULED)
    expect(mockDb.sponsored_message_sends.createMany.mock.calls[0][0].skipDuplicates).toBe(true)
  })

  it("links the posted message back to the outbox row", async () => {
    await sweepSponsored(NOW)

    expect(mockDb.sponsored_message_sends.update).toHaveBeenCalledTimes(1)
    const call = mockDb.sponsored_message_sends.update.mock.calls[0][0]
    expect(call.where.sponsored_message_id_scheduled_for).toEqual({
      sponsored_message_id: CAMPAIGN,
      scheduled_for: SCHEDULED,
    })
    expect(call.data.chat_message_id).toBe("message-1")
  })

  it("schedules the next window from now, so a backlog is not replayed", async () => {
    await sweepSponsored(NOW)

    const finalize = mockDb.event_sponsored_messages.updateMany.mock.calls.at(-1)![0]
    /*
     * From `now + interval`, never `scheduled_for + interval`. A worker down for
     * three hours would otherwise walk the schedule forward one interval at a
     * time and fire the whole backlog into the room as fast as it could claim.
     */
    expect(finalize.data.next_send_at).toEqual(new Date(NOW.getTime() + 30 * 60_000))
    expect(finalize.data.claim_token).toBeNull()
    expect(finalize.data.consecutive_failures).toBe(0)
  })

  it("guards every write on still holding the claim", async () => {
    await sweepSponsored(NOW)

    // A row whose lease expired and was taken by another worker must not be
    // finalized by this one — that would release a claim it no longer owns.
    for (const [call] of mockDb.event_sponsored_messages.updateMany.mock.calls) {
      expect(typeof call.where.claim_token).toBe("string")
      expect(call.where.claim_token).toHaveLength(36)
    }
  })
})

describe("recipients", () => {
  it("never stores a raw user id", async () => {
    await sweepSponsored(NOW)

    const row = mockDb.sponsored_message_sends.createMany.mock.calls[0][0].data[0]
    expect(row.members).toBe(2)
    expect(row.recipient_hashes).toHaveLength(2)
    /*
     * The whole reason the column is hashes. Two sends thirty minutes apart with
     * raw ids yield arrival and departure per person, and intersecting them
     * across a campaign identifies whoever attends everything.
     */
    for (const hash of row.recipient_hashes) {
      expect(hash).not.toContain("user-a")
      expect(hash).not.toContain("user-b")
      expect(hash).toMatch(/^attendee-[0-9a-f]{12}$/)
    }
  })

  it("counts only members who are still in the room", async () => {
    await sweepSponsored(NOW)

    const where = mockDb.chat_group_members.findMany.mock.calls[0][0].where
    // Not `not: banned` — that counts `left`, whose rows are KEPT because the
    // pseudonym lives on them. That bug made a blast-radius figure grow all
    // night as people went home.
    expect(where.status).toEqual({ in: ["active", "muted"] })
  })
})

describe("a window that already ran", () => {
  it("sends nothing when the outbox insert conflicts", async () => {
    mockDb.sponsored_message_sends.createMany.mockResolvedValue({ count: 0 })

    const result = await sweepSponsored(NOW)

    expect(result.duplicate).toBe(1)
    expect(result.sent).toBe(0)
    expect(mockDb.chat_messages.create).not.toHaveBeenCalled()
  })

  it("still moves the schedule on, without claiming a send", async () => {
    mockDb.sponsored_message_sends.createMany.mockResolvedValue({ count: 0 })

    await sweepSponsored(NOW)

    const finalize = mockDb.event_sponsored_messages.updateMany.mock.calls.at(-1)![0]
    expect(finalize.data.next_send_at).toEqual(new Date(NOW.getTime() + 30 * 60_000))
    // `last_sent_at` is what a report reads. This pass sent nothing.
    expect(finalize.data.last_sent_at).toBeUndefined()
  })
})

describe("things that stop a campaign", () => {
  it("gives up on an archived room rather than retrying forever", async () => {
    mockDb.events.findUnique.mockResolvedValue({
      start_time: new Date("2026-08-17T19:00:00.000Z"),
      end_time: new Date("2026-08-17T22:00:00.000Z"),
      organizer_id: "organiser-1",
      chat_group: { id: GROUP, status: "archived" },
    })

    const result = await sweepSponsored(NOW)

    /*
     * The original bug: a timer armed once never checked `chat_groups.status`,
     * and every boot re-armed it. An archived room no human could post to
     * received a sponsored message every interval, forever — 96 a day at the
     * 15-minute setting.
     */
    expect(result.deactivated).toBe(1)
    expect(mockDb.chat_messages.create).not.toHaveBeenCalled()
    const stop = mockDb.event_sponsored_messages.updateMany.mock.calls[0][0]
    expect(stop.data.is_active).toBe(false)
    expect(stop.data.next_send_at).toBeNull()
    expect(stop.data.deactivated_reason).toMatch(/archived/)
  })

  it("respects the pre-event floor", async () => {
    mockDb.events.findUnique.mockResolvedValue({
      // Doors in three days: the room has not opened yet.
      start_time: new Date("2026-08-20T19:00:00.000Z"),
      end_time: new Date("2026-08-20T22:00:00.000Z"),
      organizer_id: "organiser-1",
      chat_group: { id: GROUP, status: "active" },
    })

    const result = await sweepSponsored(NOW)

    expect(result.deactivated).toBe(1)
    expect(mockDb.chat_messages.create).not.toHaveBeenCalled()
  })

  it("stops when there is no approved creative", async () => {
    mockDb.sponsored_creatives.findFirst.mockResolvedValue(null)

    const result = await sweepSponsored(NOW)

    expect(result.deactivated).toBe(1)
    expect(mockDb.chat_messages.create).not.toHaveBeenCalled()
  })

  it("sends the approved revision, not the campaign's current content", async () => {
    // A campaign's `content` can be ahead of what has been reviewed. What runs
    // is the approved creative, which is also what the send records against.
    mockDb.sponsored_creatives.findFirst.mockResolvedValue({
      id: "creative-7",
      content: "The reviewed words",
      media_url: null,
    })

    await sweepSponsored(NOW)

    expect(mockDb.sponsored_creatives.findFirst.mock.calls[0][0].where).toMatchObject({
      message_id: CAMPAIGN,
      moderation_status: "approved",
    })
    expect(mockDb.chat_messages.create.mock.calls[0][0].data.content).toContain(
      "The reviewed words"
    )
    expect(mockDb.sponsored_message_sends.createMany.mock.calls[0][0].data[0].creative_id).toBe(
      "creative-7"
    )
  })

  it("deactivates after the failure limit and not before", async () => {
    mockDb.chat_messages.create.mockRejectedValue(new Error("boom"))

    mockDb.$queryRaw.mockResolvedValue(claimed({ consecutive_failures: 0 }))
    await sweepSponsored(NOW)
    let last = mockDb.event_sponsored_messages.updateMany.mock.calls.at(-1)![0]
    expect(last.data.is_active).toBeUndefined()
    expect(last.data.consecutive_failures).toBe(1)

    jest.clearAllMocks()
    mockDb.$queryRaw.mockResolvedValue(
      claimed({ consecutive_failures: SPONSORSHIP.FAILURE_LIMIT - 1 })
    )
    mockDb.events.findUnique.mockResolvedValue({
      start_time: new Date("2026-08-17T19:00:00.000Z"),
      end_time: new Date("2026-08-17T22:00:00.000Z"),
      organizer_id: "organiser-1",
      chat_group: { id: GROUP, status: "active" },
    })
    mockDb.sponsored_message_sends.findFirst.mockResolvedValue(null)
    mockDb.sponsored_creatives.findFirst.mockResolvedValue({
      id: "creative-1",
      content: "Stay hydrated",
      media_url: null,
    })
    mockDb.chat_group_members.findMany.mockResolvedValue([{ user_id: "user-a" }])
    mockDb.sponsored_message_sends.createMany.mockResolvedValue({ count: 1 })
    mockDb.chat_messages.create.mockRejectedValue(new Error("boom"))

    await sweepSponsored(NOW)
    last = mockDb.event_sponsored_messages.updateMany.mock.calls.at(-1)![0]
    expect(last.data.is_active).toBe(false)
    expect(last.data.deactivated_reason).toMatch(/consecutive send failures/)
  })
})

describe("the room-wide gap", () => {
  it("defers behind another sponsor rather than dropping the send", async () => {
    const other = new Date(NOW.getTime() - 5 * 60_000)
    mockDb.sponsored_message_sends.findFirst.mockResolvedValue({ sent_at: other })

    const result = await sweepSponsored(NOW)

    expect(result.deferred).toBe(1)
    expect(mockDb.chat_messages.create).not.toHaveBeenCalled()

    const defer = mockDb.event_sponsored_messages.updateMany.mock.calls[0][0]
    // Pushed to exactly the end of the other sponsor's gap. Dropping it instead
    // would silently cost the sponsor a send they paid for.
    expect(defer.data.next_send_at).toEqual(
      new Date(other.getTime() + SPONSORSHIP.ROOM_MIN_GAP_MINUTES * 60_000)
    )
    expect(defer.data.is_active).toBeUndefined()
  })

  it("measures the gap across every sponsor in the room, excluding itself", async () => {
    await sweepSponsored(NOW)

    const where = mockDb.sponsored_message_sends.findFirst.mock.calls[0][0].where
    /*
     * Across ALL sponsors, by event. Three advertisers each behaving perfectly
     * at 30 minutes still put something in the room every ten, and the attendee
     * does not care that each one behaved.
     */
    expect(where.message.event_id).toBe(EVENT)
    expect(where.NOT.sponsored_message_id).toBe(CAMPAIGN)
    expect(where.sent_at.gte).toEqual(
      new Date(NOW.getTime() - SPONSORSHIP.ROOM_MIN_GAP_MINUTES * 60_000)
    )
  })
})

describe("the claim", () => {
  const SOURCE = readFileSync(join(__dirname, "..", "lib", "sponsored-scheduler.ts"), "utf8")
  /*
   * The SQL alone. Scoped this way because the module doc *discusses*
   * `may_sponsor` at length to explain why the query leaves it out, and an
   * assertion over the whole file would read that prose as the code.
   */
  const SQL = SOURCE.slice(
    SOURCE.indexOf("async function claimDue"),
    SOURCE.indexOf("/** Release the claim")
  )

  it("uses SKIP LOCKED, without which two workers send the same ad twice", () => {
    /*
     * Asserted against the source because there is no way to observe row-level
     * locking through a mock, and this one clause is the entire reason a second
     * container does not double every campaign's send rate.
     */
    expect(SQL).toMatch(/FOR UPDATE OF m SKIP LOCKED/)
  })

  it("re-checks the placement in the due select", () => {
    // Cancelling a placement is the documented way to stop sends —
    // `lib/onboarding-actions.ts` says revoking `may_sponsor` deliberately does
    // not. So this filter is the kill switch, and it has to be in the query
    // rather than checked after the claim.
    expect(SQL).toMatch(/p\."status" = 'approved'::"placement_status"/)
  })

  it("does not re-check may_sponsor, which is the documented behaviour", () => {
    // Revoking the grant must not silently kill placements an organiser has
    // already paid for. If this ever needs to change, change the doc in
    // lib/onboarding-actions.ts in the same commit.
    expect(SQL).not.toMatch(/may_sponsor/)
  })

  it("only claims rows whose lease has expired", () => {
    expect(SQL).toMatch(/"claimed_at" < \$\{leaseCutoff\}/)
  })
})

describe("firstWindow", () => {
  it("is now, so switching a campaign on is not an interval of silence", () => {
    // `setInterval` has no leading edge. Flipping the switch and seeing nothing
    // for thirty minutes reads as a broken control, and it was.
    expect(firstWindow(NOW)).toEqual(NOW)
  })
})
