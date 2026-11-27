/*
 * A complaint category one person wrote most of (SCRUM-1285), on real rows.
 *
 * Five people clear the people floor while one of them wrote 20 of 25 messages.
 * The live snapshot and the digest hold its count back, as they hold back a
 * category under the floor, and say nothing about why. The 180-day purge
 * freezes the largest single person's count beside the people, so the rule
 * still holds once nobody's messages can be counted. Storage is never touched.
 */
jest.mock("@/lib/tigris", () => ({ ...jest.requireActual("@/lib/tigris"), isConfigured: () => true, deleteFile: jest.fn() }))

import { Prisma } from "@prisma/client"

import { buildFeedbackDigest } from "@/lib/feedback-digest"
import { readLiveSnapshot } from "@/lib/live-snapshot"
import { purgeClosedLobbies } from "@/lib/lobby-retention"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const users: string[] = []
const events: string[] = []
let eventId = ""
let roomId = ""

afterAll(async () => {
  await db.event_feedback.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.chat_messages.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

/** `messages[i]` negative messages in `category` from `people[i]`. */
async function wrote(people: string[], category: string, messages: number[]) {
  for (const [i, n] of messages.entries()) {
    for (let k = 0; k < n; k++) {
      const message = await db.chat_messages.create({ data: { chat_group_id: roomId, user_id: people[i], content: `${category} ${k}` } })
      await db.event_feedback.create({ data: { event_id: eventId, message_id: message.id, sentiment: "negative", category: category as never, confidence: 0.9, source: "lexicon" } })
    }
  }
}

beforeAll(async () => {
  const host = await makeUser(testId("cd-host"), "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
  roomId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room" }, select: { id: true } })).id
  const occurrenceId = await occurrenceOf(eventId)
  const members: string[] = []
  for (let i = 0; i < 14; i++) {
    const id = await makeUser(testId(`cd-${i}`))
    users.push(id)
    members.push(id)
    await db.chat_group_members.create({ data: { chat_group_id: roomId, user_id: id, anonymous_name: testId(`Pseudo ${i}`) } })
    await putInRoom({ eventId, occurrenceId, userId: id })
  }
  // One person wrote 20 of entry_queue's 25, across five people; crowding is five people, two each; safety is one person.
  await wrote(members.slice(0, 5), "entry_queue", [20, 2, 1, 1, 1])
  await wrote(members.slice(5, 10), "crowding", [2, 2, 2, 2, 2])
  await wrote(members.slice(10, 11), "safety_conduct", [1])
})

const eventRow = () => db.events.findUniqueOrThrow({ where: { id: eventId }, select: { id: true, title: true, end_time: true, timezone: true } })
const named = (categories: { category: string }[], name: string) => categories.find((c) => c.category === name)
/** The entry as the host gets it, its name aside: a dominated category must be indistinguishable from a sub-floor one. */
const unnamed = (c: object | undefined) => ({ ...c, category: "X" })

describe("the live snapshot", () => {
  it("holds the dominated category back exactly as a category under the floor, and shows the evenly spread one", async () => {
    const snapshot = (await readLiveSnapshot(eventId, undefined, { social: true }).then((r) => r?.snapshot ?? null))!
    expect(named(snapshot.categories, "entry_queue")).toEqual({ category: "entry_queue", count: null, suppressed: true })
    expect(unnamed(named(snapshot.categories, "entry_queue"))).toEqual(unnamed(named(snapshot.categories, "safety_conduct")))
    expect(named(snapshot.categories, "crowding")).toEqual({ category: "crowding", count: 10, suppressed: false })
    // What the socket sends a host (`ops:snapshot`): no reason anywhere.
    const sent = JSON.stringify(snapshot)
    expect(sent).not.toContain("suppressionReason")
    expect(sent).not.toContain("dominance")
  })
})

describe("the digest", () => {
  it("holds it back, quotes none of it, and carries no reason", async () => {
    const digest = await buildFeedbackDigest(await eventRow(), "host")
    expect(named(digest.categories, "entry_queue")).toEqual({ category: "entry_queue", count: null, suppressed: true })
    expect(unnamed(named(digest.categories, "entry_queue"))).toEqual(unnamed(named(digest.categories, "safety_conduct")))
    expect(named(digest.categories, "crowding")).toEqual({ category: "crowding", count: 10, suppressed: false })
    // A held-back count's quotes would give it back: only crowding's ten are quotable.
    expect(digest.messagesTotal).toBe(10)
    expect(digest.messages.every((m) => m.category === "crowding")).toBe(true)
    const props = JSON.stringify(digest)
    expect(props).not.toContain("suppressionReason")
    expect(props).not.toContain("dominance")
  })
})

describe("through the 180-day purge", () => {
  it("freezes the largest single person's count and still holds the category back from the tally", async () => {
    const before = (await buildFeedbackDigest(await eventRow(), "host")).categories
    await db.events.update({ where: { id: eventId }, data: { start_time: ago(182.2), end_time: ago(182) } })
    await db.chat_messages.updateMany({ where: { chat_group_id: roomId }, data: { created_at: ago(182.1) } })
    await purgeClosedLobbies()

    expect(await db.chat_messages.count({ where: { chat_group_id: roomId } })).toBe(0)
    const tally = await db.event_feedback_tallies.findUniqueOrThrow({ where: { event_id: eventId } })
    expect(tally.top_messages).toEqual({ entry_queue: 20, crowding: 2, safety_conduct: 1 })
    expect((await buildFeedbackDigest(await eventRow(), "host")).categories).toEqual(before)
  })

  it("reads a tally frozen before the count was recorded as before: no dominance", async () => {
    await db.event_feedback_tallies.update({ where: { event_id: eventId }, data: { top_messages: Prisma.DbNull } })
    const { categories } = await buildFeedbackDigest(await eventRow(), "host")
    expect(named(categories, "entry_queue")).toEqual({ category: "entry_queue", count: 25, suppressed: false })
  })
})
