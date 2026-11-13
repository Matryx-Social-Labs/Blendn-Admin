/*
 * The Feedback tab's quotes, paged and with no name (SCRUM-1051, step 6;
 * owner approval 7, 2026-11-12).
 *
 * The list was unbounded (90 quotes on one page in the local run, G8), and it
 * was the one place a host read individual words beside a room-stable
 * pseudonym and the minute they were said. Now 20 at a time, server-side, no
 * pseudonym at all, and the hour only, in the event's own zone.
 */
import { buildFeedbackDigest, QUOTES_PER_PAGE } from "@/lib/feedback-digest"

import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.chat_messages.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await cleanup(users, events)
  await closeDb()
})

async function roomOf(size: number) {
  const host = await makeUser("fq-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { timezone: "Asia/Kolkata" } })
  const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room" } })
  const members: string[] = []
  for (let i = 0; i < size; i++) {
    const id = await makeUser(`fq-m${i}`)
    users.push(id)
    members.push(id)
    await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: id, anonymous_name: `Pseudo Fq ${i}` } })
  }
  return { eventId, roomId: room.id, members }
}

async function says(eventId: string, roomId: string, userId: string, category: string, text: string, at: Date) {
  const message = await db.chat_messages.create({ data: { chat_group_id: roomId, user_id: userId, content: text, created_at: at } })
  await db.event_feedback.create({
    data: { event_id: eventId, message_id: message.id, sentiment: "negative", category: category as never, confidence: 0.9, source: "lexicon" as never, created_at: at },
  })
}

const eventRow = (id: string) => db.events.findUniqueOrThrow({ where: { id }, select: { id: true, title: true, end_time: true, timezone: true } })

describe("quotes come 20 at a time", () => {
  it("pages the quotable rows, earliest first, with the total beside them", async () => {
    const { eventId, roomId, members } = await roomOf(10)
    const base = Date.parse("2026-11-10T14:00:00Z")
    for (let i = 0; i < 45; i++) await says(eventId, roomId, members[i % 6], "entry_queue", `queue ${i}`, new Date(base + i * 60_000))
    // The control: a category under the floor is never quoted, and never counted as a quote.
    await says(eventId, roomId, members[7], "safety_conduct", "held back", new Date(base))

    const event = await eventRow(eventId)
    const [one, two, three] = await Promise.all([1, 2, 3].map((page) => buildFeedbackDigest(event, "host", page)))

    expect(QUOTES_PER_PAGE).toBe(20)
    expect([one.messages.length, two.messages.length, three.messages.length]).toEqual([20, 20, 5])
    expect(one).toMatchObject({ messagesTotal: 45, messagesPage: 1 })
    expect(one.messages[0].text).toBe("queue 0")
    expect(three.messages.at(-1)?.text).toBe("queue 44")
    const ids = [...one.messages, ...two.messages, ...three.messages].map((m) => m.id)
    expect(new Set(ids).size).toBe(45)
  })

  it("clamps a page past the end to the last one, and nonsense to the first", async () => {
    const { eventId, roomId, members } = await roomOf(10)
    for (let i = 0; i < 25; i++) await says(eventId, roomId, members[i % 6], "entry_queue", `q ${i}`, new Date(Date.now() - (30 - i) * 60_000))
    const event = await eventRow(eventId)

    expect(await buildFeedbackDigest(event, "host", 99)).toMatchObject({ messagesPage: 2, messagesTotal: 25 })
    expect((await buildFeedbackDigest(event, "host", 99)).messages).toHaveLength(5)
    expect(await buildFeedbackDigest(event, "host", Number.NaN)).toMatchObject({ messagesPage: 1 })
    expect(await buildFeedbackDigest(event, "host", -3)).toMatchObject({ messagesPage: 1 })
  })
})

describe("a quote carries no name and the hour only (approval 7)", () => {
  it("drops the pseudonym and says the hour in the event's own zone", async () => {
    const { eventId, roomId, members } = await roomOf(10)
    // 21:37:42 in Kolkata. Truncating in UTC would say 21:30 there; the hour is 21:00.
    for (const m of members.slice(0, 5)) await says(eventId, roomId, m, "entry_queue", "the queue", new Date("2026-11-10T16:07:42Z"))

    const digest = await buildFeedbackDigest(await eventRow(eventId), "host")

    expect(digest.messages).toHaveLength(5)
    for (const m of digest.messages) {
      expect(Object.keys(m).sort()).toEqual(["category", "confidence", "corrected", "hour", "id", "sentiment", "text"])
      expect(m.hour).toBe("2026-11-10T15:30:00.000Z")
    }
    const payload = JSON.stringify(digest)
    expect(payload).not.toMatch(/Pseudo Fq/)
    for (const id of members) expect(payload).not.toContain(id)
  })

  it("gives a venue no quotes and no quote count", async () => {
    const { eventId, roomId, members } = await roomOf(10)
    for (const m of members.slice(0, 5)) await says(eventId, roomId, m, "entry_queue", "the queue", new Date())
    expect(await buildFeedbackDigest(await eventRow(eventId), "venue")).toMatchObject({ messages: [], messagesTotal: 0 })
  })
})
