process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { matchesForEvent } from "@/lib/matches"
import { resolveUserRef } from "@/lib/room-handle"

import { arrive, befriend, cleanupCrewWorld, liveEvent, person, type Person } from "./crew-world"
import { db } from "./helpers"
import { sqlCounter } from "./sql-count"

/**
 * The match deck names the cards it returns, not the room (perf/hot-paths #1).
 *
 * Ranking needs the whole room; the pseudonym and the reveal rule are only
 * display, so they are asked of the page. The snapshot was taken BEFORE the
 * change over a room with every case the identity rule has a branch for
 * (revealed, friend, blocked, closed pair, "show online" off), paged at 3 of
 * a dozen: it must not change.
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

const PAGE = 3
const placeholders = (q: string) => new Set(q.match(/\$\d+/g) ?? []).size

async function world() {
  const viewer = await person("dk-viewer", "Vee Viewer Rao")
  const host = await person("dk-host")
  const { eventId, occurrenceId } = await liveEvent(host.id)
  // Most recent first is the tie-break: the order below is the deck's order.
  const cast: { label: string; revealed?: boolean; how?: "friend" | "blocked" | "closed" | "offline" }[] = [
    { label: "friend", revealed: true, how: "friend" },
    { label: "blocked", revealed: true, how: "blocked" },
    { label: "closed", revealed: true, how: "closed" },
    { label: "offline", revealed: true, how: "offline" },
    { label: "plain-1" },
    { label: "revealed-1", revealed: true },
    { label: "plain-2" },
    { label: "revealed-2", revealed: true },
    { label: "plain-3" },
    { label: "plain-4" },
    { label: "plain-5" },
    { label: "revealed-3", revealed: true },
  ]
  await arrive(eventId, occurrenceId, viewer, "Otter Viewer")
  const people = new Map<string, Person>()
  const now = Date.now()
  for (const [i, c] of cast.entries()) {
    const p = await person(`dk-${c.label}`, `Name ${c.label}`)
    people.set(c.label, p)
    await arrive(eventId, occurrenceId, p, `Pseudo ${c.label}`)
    await db.event_check_ins.updateMany({ where: { event_id: eventId, user_id: p.id }, data: { check_in_time: new Date(now - i * 60_000) } })
    await db.user.update({ where: { id: p.id }, data: { name: `Name ${c.label}` } })
    await db.profiles.update({ where: { id: p.id }, data: { photos: [`https://img.invalid/${c.label}.jpg`], ...(c.how === "offline" && { show_online: false }) } })
    if (c.revealed) await db.event_match_preferences.create({ data: { event_id: eventId, user_id: p.id, revealed: true } })
    if (c.how === "friend") await befriend(viewer, p)
    if (c.how === "blocked") await db.blocked_users.create({ data: { blocker_id: viewer.id, blocked_id: p.id } })
    if (c.how === "closed") {
      const [user1_id, user2_id] = [viewer.id, p.id].sort()
      await db.private_conversations.create({ data: { user1_id, user2_id, closed_at: new Date() } })
    }
  }
  return { viewer, eventId, label: new Map([...people].map(([l, p]) => [p.id, l])) }
}

describe("the match deck", () => {
  it("names a page of cards, and the cards are what they were", async () => {
    const { viewer, eventId, label } = await world()
    // One call only: a deck records what it showed, and a second would rank differently.
    const { result: cards, sql } = await counter.during(() => matchesForEvent(eventId, viewer.id, PAGE))

    const shaped = cards!.map(({ userId, ...card }) => ({ who: label.get(resolveUserRef(userId)!.userId), ...card }))
    expect(shaped).toMatchSnapshot()

    // Before: a pseudonym row and five reveal-rule lists for every one of the
    // dozen people in the room. After: the page.
    const pseudonymRead = sql.find((q) => /FROM "public"\."chat_group_members"/.test(q) && /"anonymous_name"/.test(q))!
    expect(pseudonymRead).toMatch(/"user_id"\s+IN/)
    expect(placeholders(pseudonymRead)).toBeLessThanOrEqual(PAGE + 3)
    const reveals = sql.find((q) => /FROM "public"\."event_match_preferences"/.test(q) && /"revealed"/.test(q))!
    expect(placeholders(reveals)).toBeLessThanOrEqual(PAGE + 3)
  })
})
