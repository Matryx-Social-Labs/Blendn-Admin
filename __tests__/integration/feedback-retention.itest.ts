/*
 * The purge keeps what a room felt and forgets who said it (owner, 2026-11-06).
 *
 * 180 days after the close the room's messages go (lib/lobby-retention.ts).
 * `event_feedback` used to go with them (ON DELETE CASCADE), so the event's
 * Feedback tab emptied. Now its non-identifying figures stay: every feedback
 * row is kept, detached from its message and from whoever corrected it, and
 * the per-category contributor counts and the room's size are frozen before
 * the first message goes. Real rows; storage is never touched here.
 */
jest.mock("@/lib/tigris", () => ({ ...jest.requireActual("@/lib/tigris"), isConfigured: () => true, deleteFile: jest.fn() }))

import { buildFeedbackDigest } from "@/lib/feedback-digest"
import { purgeClosedLobbies } from "@/lib/lobby-retention"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const users: string[] = []
const events: string[] = []
let eventId = ""
let room = ""
let host = ""
const people: string[] = []
const pseudonyms: string[] = []

afterAll(async () => {
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.event_feedback.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

beforeAll(async () => {
  host = await makeUser(testId("fbr-host"), "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
  // Ended 182 days ago, so it closed 181 days ago: past its time.
  await db.events.update({ where: { id: eventId }, data: { start_time: ago(182.2), end_time: ago(182) } })
  room = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "archived" }, select: { id: true } })).id

  // Eight people in the room.
  for (let i = 0; i < 8; i++) {
    const id = await makeUser(testId(`fbr-${i}`))
    users.push(id)
    people.push(id)
    const name = testId(`Cosmic Panda ${i}`)
    pseudonyms.push(name)
    await db.chat_group_members.create({ data: { chat_group_id: room, user_id: id, anonymous_name: name } })
  }
  const said = async (who: number, content: string, sentiment: "positive" | "neutral" | "negative", category: string, corrected = false) => {
    const m = await db.chat_messages.create({ data: { chat_group_id: room, user_id: people[who], content, created_at: ago(182.1) }, select: { id: true } })
    await db.event_feedback.create({
      data: {
        event_id: eventId,
        message_id: m.id,
        sentiment,
        category: category as never,
        confidence: corrected ? 1 : 0.8,
        source: corrected ? "human" : "lexicon",
        ...(corrected && { corrected_by: host, corrected_at: ago(181.5) }),
      },
    })
  }
  // Six people about the queue (one twice): disclosed, and quotable, before the purge.
  for (let i = 0; i < 6; i++) await said(i, `The queue at the door, take ${i}`, "negative", "entry_queue", i === 2)
  await said(0, "Still queueing", "negative", "entry_queue")
  // One person about safety: held back under the floor, but listed.
  await said(6, "Someone was pushing near the bar", "negative", "safety_conduct")
  await said(7, "Great night", "positive", "other")
})

/** What the Feedback tab shows, less the quotes (they are words, and the words go). */
const figures = async (view: "host" | "venue") => {
  const event = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { id: true, title: true, end_time: true, timezone: true } })
  const { counts, total, categories, ratingCount, averageRating, messages } = await buildFeedbackDigest(event, view)
  return { figures: { counts, total, categories, ratingCount, averageRating }, quotes: messages.length }
}

describe("feedback through the 180-day purge", () => {
  let before: { host: Awaited<ReturnType<typeof figures>>; venue: Awaited<ReturnType<typeof figures>> }

  it("shows real figures before it: a disclosed category, a held-back one, and quotes", async () => {
    before = { host: await figures("host"), venue: await figures("venue") }
    expect(before.host.figures.total).toBe(9)
    expect(before.host.figures.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "entry_queue", count: 7, suppressed: false }),
        expect.objectContaining({ category: "safety_conduct", count: null, suppressed: true }),
      ])
    )
    expect(before.host.quotes).toBeGreaterThan(0)
  })

  it("leaves every figure the host and the venue see exactly as it was", async () => {
    await purgeClosedLobbies(new Date(), "delete")
    expect(await db.chat_messages.count({ where: { chat_group_id: room } })).toBe(0)
    expect((await figures("host")).figures).toEqual(before.host.figures)
    expect((await figures("venue")).figures).toEqual(before.venue.figures)
    // The quotes were the words, and the words are gone.
    expect((await figures("host")).quotes).toBe(0)
  })

  it("keeps every feedback row, with nothing left that identifies a person", async () => {
    const rows = await db.event_feedback.findMany({ where: { event_id: eventId } })
    expect(rows).toHaveLength(9)
    for (const row of rows) expect(row).toMatchObject({ message_id: null, corrected_by: null })
    const tally = await db.event_feedback_tallies.findUniqueOrThrow({ where: { event_id: eventId } })
    expect(tally).toMatchObject({ population: 8, contributors: { entry_queue: 6, safety_conduct: 1 } })
    const kept = JSON.stringify({ rows, tally })
    for (const id of [host, ...people]) expect(kept).not.toContain(id)
    for (const name of pseudonyms) expect(kept).not.toContain(name)
  })

  it("is the same on the next pass", async () => {
    await purgeClosedLobbies(new Date(), "delete")
    expect((await figures("host")).figures).toEqual(before.host.figures)
    expect(await db.event_feedback.count({ where: { event_id: eventId } })).toBe(9)
  })
})

describe("a dismissed report's excerpt", () => {
  it("goes 180 days after the dismissal; a recent dismissal, an upheld and a pending report keep theirs", async () => {
    const reporter = people[7]
    const report = (status: "pending" | "reviewed" | "resolved", reviewedDaysAgo: number | null) =>
      db.message_reports.create({
        data: {
          reporter_id: reporter,
          message_id: crypto.randomUUID(),
          message_type: "board_post",
          reason: "spam",
          excerpt: `Ride from Indiranagar ${testId("x")}`,
          status,
          ...(reviewedDaysAgo !== null && { reviewed_at: ago(reviewedDaysAgo) }),
        },
        select: { id: true },
      })
    const aged = await report("reviewed", 190)
    const fresh = await report("reviewed", 10)
    const upheld = await report("resolved", 190)
    const pending = await report("pending", null)

    await purgeClosedLobbies(new Date(), "delete")
    const excerpt = async (r: { id: string }) => (await db.message_reports.findUniqueOrThrow({ where: { id: r.id } })).excerpt
    expect(await excerpt(aged)).toBeNull()
    for (const r of [fresh, upheld, pending]) expect(await excerpt(r)).not.toBeNull()
  })
})
