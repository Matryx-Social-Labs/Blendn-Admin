process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { notifyFriendsHere } from "@/lib/room-friends"

import { arrive, befriend, cleanupCrewWorld, liveEvent, person } from "./crew-world"
import { db } from "./helpers"
import { sqlCounter } from "./sql-count"

/**
 * notifyFriendsHere runs on every check-in and checkout (perf/hot-paths #14).
 * Given the events (always, from both callers) it still read which events the
 * subject is live in, and threw the answer away.
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

it("reads the check-ins once when the caller names the event", async () => {
  const subject = await person("fs-subject")
  const friend = await person("fs-friend")
  const host = await person("fs-host")
  await db.profiles.updateMany({ where: { id: { in: [subject.id, friend.id] } }, data: { friends_see_me_in_rooms: true, show_online: true } })
  await befriend(subject, friend)
  const { eventId, occurrenceId } = await liveEvent(host.id)
  await arrive(eventId, occurrenceId, subject)
  await arrive(eventId, occurrenceId, friend)

  const { sql } = await counter.during(async () => notifyFriendsHere(subject.id, { eventIds: [eventId] }))

  // Before: the subject's own live events (discarded) and the friends' rows.
  expect(sql.filter((q) => /FROM "public"\."event_check_ins"/.test(q)).length).toBe(1)
})
