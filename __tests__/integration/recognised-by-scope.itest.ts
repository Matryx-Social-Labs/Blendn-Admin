process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { recognisedInRoomBy, visibleInRoom } from "@/lib/identity"
import { hereCountCoalesced } from "@/lib/attendee-counts"

import { arrive, befriend, cleanupCrewWorld, liveEvent, person, type Person } from "./crew-world"
import { db } from "./helpers"
import { sqlCounter } from "./sql-count"

/**
 * Per arrival, the socket emitters ask two room-sized questions (perf/hot-paths #8).
 *
 * 1. Which of everyone listening recognises the arriver (`recognisedInRoomBy`):
 *    five reads with `IN (every listener)`. Now the arriver's own reveal and
 *    friendships say who could, and only those are asked the full rule.
 * 2. How many are in the room (`hereCountFor`): a count per arrival. Arrivals
 *    that overlap now share one read that started after the last of them committed.
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

const LISTENERS = 40
const placeholders = (q: string) => new Set(q.match(/\$\d+/g) ?? []).size

async function world() {
  const host = await person("rb-host")
  const { eventId, occurrenceId } = await liveEvent(host.id)
  const target = await person("rb-target")
  const revealedTarget = await person("rb-revealed")
  const friendSees = await person("rb-friend-sees")
  const friendBlocked = await person("rb-friend-blocked")
  const friendAway = await person("rb-friend-away") // a friend who is not in the room
  const closed = await person("rb-closed")
  const strangers = await Promise.all(Array.from({ length: LISTENERS }, (_, i) => person(`rb-s${i}`)))
  await db.profiles.update({ where: { id: target.id }, data: { friends_see_me_in_rooms: true } })
  await db.profiles.update({ where: { id: revealedTarget.id }, data: { friends_see_me_in_rooms: false } })
  for (const p of [target, revealedTarget, friendSees, friendBlocked, closed, ...strangers]) await arrive(eventId, occurrenceId, p)
  await befriend(target, friendSees, friendBlocked, friendAway)
  await db.blocked_users.create({ data: { blocker_id: friendBlocked.id, blocked_id: target.id } })
  await db.event_match_preferences.create({ data: { event_id: eventId, user_id: revealedTarget.id, revealed: true } })
  const [user1_id, user2_id] = [revealedTarget.id, closed.id].sort()
  await db.private_conversations.create({ data: { user1_id, user2_id, closed_at: new Date() } })
  const listeners: Person[] = [friendSees, friendBlocked, friendAway, closed, target, revealedTarget, ...strangers]
  return { eventId, target, revealedTarget, listeners }
}

describe("recognisedInRoomBy", () => {
  it("answers each listener as the roster would, and asks for the arriver's own graph, not the room's", async () => {
    const { eventId, target, revealedTarget, listeners } = await world()
    const ids = listeners.map((p) => p.id)
    for (const arriver of [target, revealedTarget]) {
      const { result: seers, sql } = await counter.during(() => recognisedInRoomBy(eventId, arriver.id, ids))
      for (const v of ids) {
        const reference = v === arriver.id || (await visibleInRoom(v, eventId, [arriver.id])).has(arriver.id)
        expect(seers.has(v)).toBe(reference)
      }
      if (arriver === target) {
        // Before: five reads, most with an IN list of all 46 listeners (46+ parameters). A private arriver's recognisers are their friends.
        expect(Math.max(...sql.map(placeholders))).toBeLessThanOrEqual(12)
        expect([...seers].sort()).toEqual([target.id, listeners[0].id].sort())
      }
    }
  })
})

describe("the room's headline count", () => {
  it("is one read for arrivals that overlap, and never older than the arrival that asked", async () => {
    const host = await person("hc-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const first = await person("hc-1")
    await arrive(eventId, occurrenceId, first)

    const burst = await counter.during(() => Promise.all(Array.from({ length: 20 }, () => hereCountCoalesced(eventId))))
    expect(burst.result).toEqual(Array(20).fill(1))
    expect(burst.sql.length).toBeLessThanOrEqual(2) // before: 20

    // A later arrival is counted by a read that starts after it: no stale count.
    const second = await person("hc-2")
    await arrive(eventId, occurrenceId, second)
    expect(await hereCountCoalesced(eventId)).toBe(2)
  })
})
