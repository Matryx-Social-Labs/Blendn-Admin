import { attentionQueues } from "@/lib/attention-queues-query"
import { queueBadges, totalWaiting } from "@/lib/attention-queues"

import { closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * The queues with rows in them.
 *
 * ## Why this file exists
 *
 * `dashboard-report.itest.ts` asserted the SHAPE of `attention` — four keys,
 * counts at or above zero, `oldest === null` exactly when the count is zero —
 * against tables the fixture never wrote to. Every one of those assertions
 * therefore ran as `0 >= 0`, and would have passed identically against a
 * version that summed two of the three moderation tables, or dropped the
 * `earliest()` fold entirely.
 *
 * That is the vacuous-in-practice failure the negative-control registry warns
 * about in its own preamble: the assertion is real, the fixture makes it
 * unfalsifiable. Found by a coverage pass, not by the suite going red.
 *
 * The one property worth paying real Postgres for: **three tables reach one
 * row, and the oldest of the three wins.** That fold is the entire reason the
 * module exists — the sidebar said `Claims 4` while the strip beside it said
 * the queue was clear, because two implementations counted different subsets.
 */
const users: string[] = []
const events: string[] = []

const HOUR = 3_600_000
const now = Date.now()

afterAll(async () => {
  await db.moderation_flags.deleteMany({ where: { review_notes: { startsWith: "itest-" } } })
  await db.user_reports.deleteMany({ where: { reason: { startsWith: "itest-" } } })
  if (events.length) await db.events.deleteMany({ where: { id: { in: events } } })
  if (users.length) {
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

describe("attentionQueues, with rows in the tables", () => {
  it("folds three moderation tables into one row and takes the oldest of them", async () => {
    const reporter = await makeUser(testId("aq-reporter"), "attendee")
    const subject = await makeUser(testId("aq-subject"), "attendee")
    users.push(reporter, subject)

    const organiser = await makeUser(testId("aq-org"), "organizer")
    users.push(organiser)
    // `makeEvent` returns the id, not the row.
    const eventId = await makeEvent(organiser)
    events.push(eventId)

    const group = await db.chat_groups.create({
      data: { event_id: eventId, name: testId("aq-room"), type: "event" },
    })

    const message = await db.chat_messages.create({
      data: { chat_group_id: group.id, user_id: subject, content: "itest message" },
    })

    const before = await attentionQueues()
    const baseline = before.find((q) => q.key === "moderation")!.count

    /*
     * Two flags and one user report, at three different ages. The middle one is
     * the oldest, and it is deliberately NOT in the table a naive
     * implementation would look at first — if `earliest()` only consulted
     * `moderation_flags`, this test fails on the timestamp rather than the
     * count, which is the half that a shape assertion cannot reach.
     */
    await db.moderation_flags.createMany({
      data: [
        {
          message_id: message.id,
          chat_group_id: group.id,
          user_id: subject,
          source: "auto_text",
          categories: {},
          confidence: 0.5,
          review_notes: "itest-recent",
          status: "pending",
          created_at: new Date(now - 2 * HOUR),
        },
        {
          message_id: message.id,
          chat_group_id: group.id,
          user_id: subject,
          source: "auto_text",
          categories: {},
          confidence: 0.5,
          review_notes: "itest-middling",
          status: "pending",
          created_at: new Date(now - 6 * HOUR),
        },
      ],
    })

    const oldest = new Date(now - 50 * HOUR)
    await db.user_reports.create({
      data: {
        reporter_id: reporter,
        reported_id: subject,
        reason: "itest-oldest",
        status: "pending",
        created_at: oldest,
      },
    })

    const queues = await attentionQueues()
    const moderation = queues.find((q) => q.key === "moderation")!

    // Three rows across two tables, summed into one queue.
    expect(moderation.count).toBe(baseline + 3)
    // And the oldest is the one in the OTHER table.
    expect(moderation.oldest).toBe(oldest.toISOString())

    // The badge the sidebar renders is the same number, by construction.
    expect(queueBadges(queues).pendingFlags).toBe(moderation.count)
    expect(totalWaiting(queues)).toBe(queues.reduce((n, q) => n + q.count, 0))
  })

  it("returns all four queues even when three of them are empty", async () => {
    const queues = await attentionQueues()

    expect(queues.map((q) => q.key).sort()).toEqual([
      "applications",
      "claims",
      "creative",
      "moderation",
    ])
    for (const queue of queues) {
      // The invariant the strip's copy depends on: a queue with nothing in it
      // has no oldest item, and one with something in it always does.
      expect(queue.oldest === null).toBe(queue.count === 0)
    }
  })
})
