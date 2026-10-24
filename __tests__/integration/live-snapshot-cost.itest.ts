import { buildLiveSnapshot, HELD_EVENT_MS, type HeldEvent } from "@/lib/live-snapshot"
import { recordIssuesFor } from "@/lib/event-issues"

import { sqlCounter } from "./sql-count"
import { closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

/**
 * What the live tick costs, and what it reports. The snapshot is built every
 * five seconds per watched event and every minute per live event: the chat
 * figures are one statement counting in the database, not a window of message
 * rows shipped to be de-duplicated in JS, and the issue sweep reuses the
 * snapshot's own reads instead of repeating them.
 */

const users: string[] = []
const events: string[] = []
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)

afterAll(async () => {
  await db.event_issues.deleteMany({ where: { event_id: { in: events } } })
  await db.chat_messages.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function liveRoom() {
  const host = await makeUser(testId("lsc-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { max_capacity: 2 } })
  const occurrenceId = await occurrenceOf(eventId)
  const guests: string[] = []
  for (let i = 0; i < 4; i++) {
    const id = await makeUser(testId(`lsc-g${i}`))
    users.push(id)
    guests.push(id)
    await putInRoom({ eventId, occurrenceId, userId: id })
  }
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room" } })
  const say = (user_id: string, at: Date, deleted = false) =>
    db.chat_messages.create({ data: { chat_group_id: group.id, user_id, content: "hi", created_at: at, ...(deleted && { deleted_at: new Date() }) } })
  // Last ten minutes: guest 0 twice, guest 1 once. Ten to thirty: guest 2. Older, or deleted: not counted.
  await say(guests[0], minutesAgo(2))
  await say(guests[0], minutesAgo(3))
  await say(guests[1], minutesAgo(5))
  await say(guests[2], minutesAgo(20))
  await say(guests[3], minutesAgo(45))
  await say(guests[3], minutesAgo(1), true)
  return eventId
}

describe("the chat figures", () => {
  it("count messages in the last ten minutes and distinct senders in the last thirty", async () => {
    const eventId = await liveRoom()
    const snapshot = await buildLiveSnapshot(eventId)
    expect(snapshot!.messagesPerMinute).toBe(0.3)
    expect(snapshot!.activeChatters30m).toBe(3)
  })

  it("are one statement, whatever the room said", async () => {
    const eventId = await liveRoom()
    const counter = sqlCounter()
    try {
      const { sql } = await counter.during(() => buildLiveSnapshot(eventId))
      console.info(`buildLiveSnapshot: ${sql.length} statements`)
      expect(sql.filter((s) => /chat_messages/.test(s))).toHaveLength(1)
    } finally {
      await counter.stop()
    }
  })
})

describe("a loop's ticks", () => {
  it("read the event and its days once a minute, not every pass", async () => {
    const eventId = await liveRoom()
    const held: { current?: HeldEvent } = {}
    const counter = sqlCounter()
    try {
      const first = await counter.during(() => buildLiveSnapshot(eventId, held))
      const second = await counter.during(() => buildLiveSnapshot(eventId, held))
      console.info(`tick: first ${first.sql.length} statements in ${first.levels} waves, next ${second.sql.length} in ${second.levels}`)
      expect(second.sql.length).toBe(first.sql.length - 3)
      expect(second.levels).toBeLessThan(first.levels)
      expect(second.result).toEqual({ ...first.result!, at: second.result!.at })
      // And a stale hold is read again.
      held.current = { ...held.current!, readAt: Date.now() - HELD_EVENT_MS - 1 }
      expect((await counter.during(() => buildLiveSnapshot(eventId, held))).sql.length).toBe(first.sql.length)
    } finally {
      await counter.stop()
    }
  })
})

describe("the issue sweep", () => {
  it("does not read again what the snapshot just read", async () => {
    const eventId = await liveRoom()
    const counter = sqlCounter()
    try {
      const snapshotCost = (await counter.during(() => buildLiveSnapshot(eventId))).sql.length
      const { sql } = await counter.during(() => recordIssuesFor(eventId))
      console.info(`recordIssuesFor: ${sql.length} statements (a snapshot alone: ${snapshotCost})`)
      expect(sql.filter((s) => /FROM "public"."event_occurrences"/.test(s))).toHaveLength(1)
      expect(sql.filter((s) => /FROM "public"."events"/.test(s)).length).toBe(1)
    } finally {
      await counter.stop()
    }
  })
})
