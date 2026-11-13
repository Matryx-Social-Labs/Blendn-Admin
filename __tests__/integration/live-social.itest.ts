import { buildLiveSnapshot, HELD_SOCIAL_MS, readLiveSnapshot, type HeldEvent, type HeldSocial } from "@/lib/live-snapshot"
import * as liveSocial from "@/lib/live-social"
import { liveSocialCounts } from "@/lib/live-social"

import { sqlCounter } from "./sql-count"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

/**
 * "Meeting tonight" on the Live tab (Live A, SCRUM-1051): the snapshot's
 * social block, counted from the rows, read once a minute and never by the
 * issue sweep, which has no screen to show it on.
 */

const users: string[] = []
const events: string[] = []
const crews: string[] = []
const categories: string[] = []
const lensSlugs: string[] = []

afterAll(async () => {
  await db.crew_members.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crews.deleteMany({ where: { id: { in: crews } } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.event_match_preferences.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await db.category_lenses.deleteMany({ where: { category_slug: { in: lensSlugs } } })
  await db.event_categories.deleteMany({ where: { category_id: { in: categories } } })
  await db.categories.deleteMany({ where: { id: { in: categories } } })
  await closeDb()
})

async function room(guestCount: number, lens: string | null = "work") {
  const host = await makeUser(testId("ls-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  if (lens) {
    const slug = testId("ls-cat")
    const c = await db.categories.create({ data: { name: slug, slug } })
    categories.push(c.id)
    lensSlugs.push(slug)
    await db.category_lenses.create({ data: { category_slug: slug, lens_key: lens } })
    await db.event_categories.create({ data: { event_id: eventId, category_id: c.id, primary: true } })
  }
  const occurrenceId = await occurrenceOf(eventId)
  const guests: string[] = []
  for (let i = 0; i < guestCount; i++) {
    const id = await makeUser(testId(`ls-g${i}`))
    users.push(id)
    guests.push(id)
    await putInRoom({ eventId, occurrenceId, userId: id })
  }
  return { eventId, occurrenceId, guests }
}

async function crewOf(members: string[]) {
  const crew = await db.crews.create({ data: { name: testId("ls-crew").slice(0, 30), emblem_seed: "s", created_by: members[0] } })
  crews.push(crew.id)
  for (const [i, user_id] of members.entries()) {
    await db.crew_members.create({ data: { crew_id: crew.id, user_id, role: i === 0 ? "owner" : "member", consented_reveal_at: new Date() } })
  }
}

const conversation = (a: string, b: string, data: { origin_event_id?: string; origin_board_request_id?: string }) =>
  db.private_conversations.create({ data: { user1_id: a < b ? a : b, user2_id: a < b ? b : a, ...data } })

describe("the social block's counts", () => {
  it("counts conversations opened from this room, Lobby posts by kind, Tonight's answers and crews here", async () => {
    const { eventId, occurrenceId, guests } = await room(8)
    const { eventId: elsewhere } = await room(0)
    // Two conversations from this room: one a wave opened, one a Lobby ask opened.
    await conversation(guests[0], guests[1], { origin_event_id: eventId })
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: guests[2], kind: "offer", body: "Two seats", spaces_left: 2 } })
    const ask = await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: guests[3], to_user_id: guests[2], status: "accepted", decided_at: new Date() } })
    await conversation(guests[2], guests[3], { origin_board_request_id: ask.id })
    // The controls: one from another room, one from nowhere.
    await conversation(guests[4], guests[5], { origin_event_id: elsewhere })
    await conversation(guests[6], guests[7], {})
    await db.board_posts.create({ data: { event_id: eventId, author_id: guests[4], kind: "seeking", body: "A ride back" } })
    await db.board_posts.create({ data: { event_id: eventId, author_id: guests[5], kind: "chat", body: "Hi all", deleted_at: new Date() } })
    for (const [i, g] of guests.slice(0, 3).entries()) {
      await db.event_match_preferences.create({ data: { event_id: eventId, user_id: g, tonight_answer: i < 2 ? "A robot" : null } })
    }
    // One crew with two here, one with only one here: only the first is here.
    await crewOf([guests[0], guests[1]])
    const away = await makeUser(testId("ls-away"))
    users.push(away)
    await crewOf([guests[2], away])

    expect(await liveSocialCounts(eventId, occurrenceId)).toMatchObject({
      conversations: 2,
      lobby: { offer: 1, seeking: 1, chat: 0 },
      tonight: { asked: true, answered: 2 },
      crews: { here: 1, people: 2 },
    })
  })

  it("knows a room that asks no question", async () => {
    const { eventId, occurrenceId } = await room(1, null)
    expect((await liveSocialCounts(eventId, occurrenceId)).tonight.asked).toBe(false)
  })
})

describe("the snapshot", () => {
  it("carries the host's disclosed block", async () => {
    const { eventId, guests } = await room(8)
    await db.event_waves.createMany({ data: [{ event_id: eventId, from_id: guests[0], to_id: guests[1] }, { event_id: eventId, from_id: guests[1], to_id: guests[0] }] })
    const snapshot = await buildLiveSnapshot(eventId)
    expect(snapshot!.social).toMatchObject({ attendees: 8, met: { held: false, pct: 25, connected: 2, connections: 1, byWay: { waves: "few", lobby: 0, requests: 0 } } })
  })

  it("is read once a minute by a loop, not on every five-second tick", async () => {
    const { eventId } = await room(8)
    const held: { current?: HeldEvent; social?: HeldSocial } = {}
    const counter = sqlCounter()
    const waves = (sql: string[]) => sql.filter((s) => /event_waves/.test(s)).length
    try {
      const first = await counter.during(() => buildLiveSnapshot(eventId, held))
      const second = await counter.during(() => buildLiveSnapshot(eventId, held))
      expect(waves(first.sql)).toBe(1)
      expect(waves(second.sql)).toBe(0)
      expect(second.result!.social).toEqual(first.result!.social)
      held.social = { ...held.social!, readAt: Date.now() - HELD_SOCIAL_MS - 1 }
      expect(waves((await counter.during(() => buildLiveSnapshot(eventId, held))).sql)).toBe(1)
    } finally {
      await counter.stop()
    }
  })

  it("is not read by the issue sweep, which shows nobody a panel", async () => {
    const { eventId } = await room(8)
    const counter = sqlCounter()
    try {
      const { sql, result } = await counter.during(() => readLiveSnapshot(eventId))
      expect(sql.filter((s) => /event_waves|private_conversations/.test(s))).toHaveLength(0)
      expect(result!.snapshot.social).toBeNull()
    } finally {
      await counter.stop()
    }
  })

  it("keeps the headcount and alerts when the social read fails, with the last minute's block or none", async () => {
    const { eventId } = await room(8)
    const held: { current?: HeldEvent; social?: HeldSocial } = {}
    const first = await buildLiveSnapshot(eventId, held)
    const failing = jest.spyOn(liveSocial, "liveSocialCounts").mockRejectedValue(new Error("statement timeout"))
    try {
      held.social = { ...held.social!, readAt: Date.now() - HELD_SOCIAL_MS - 1 }
      const stale = await buildLiveSnapshot(eventId, held)
      expect(stale!.inside).toBe(8)
      expect(stale!.social).toEqual(first!.social)
      // The control: with nothing held, the panel is left out, the snapshot is not.
      const fresh = await buildLiveSnapshot(eventId)
      expect(fresh!.inside).toBe(8)
      expect(fresh!.social).toBeNull()
      expect(failing).toHaveBeenCalledTimes(2)
    } finally {
      failing.mockRestore()
    }
  })
})
