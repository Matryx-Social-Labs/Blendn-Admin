/**
 * Badges on a profile (Flow 6), the positive path: who is given them, and when
 * the person's own switches take them away. Real rows, the real route.
 *
 *   - a viewer who may see who they are (a friend who opted in to being
 *     recognised, or someone in an open conversation) gets them;
 *   - the same viewer gets none when `show_badges` is off, and a stranger none;
 *   - "Shows up" appears only when `shows_up_badge` is on.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"
import { req } from "./go-live-world"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")

const users: string[] = []
const events: string[] = []
const HOUR = 3_600_000
const tokenOf = (id: string) => signAccessToken(id, `${id}@itest.invalid`)

async function person(label: string, profile: Record<string, unknown> = {}) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.profiles.upsert({ where: { id }, create: { id, name: label, onboarded: true, ...profile }, update: {} })
  return id
}

/** A night that already ended (inside the 90 days "Shows up" reads), with its one day. */
async function pastNight(host: string) {
  const start = new Date(Date.now() - 5 * HOUR)
  const end = new Date(Date.now() - 3 * HOUR)
  const event = await db.events.create({
    data: {
      slug: testId("badge_evt"), title: "Past night", description: "fixture", start_time: start, end_time: end, timezone: "UTC",
      status: "published", visibility: "public", organizer_id: host,
    },
  })
  await db.event_occurrences.create({ data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end } })
  events.push(event.id)
  return event.id
}

/** `n` past nights the person said they were going to and checked in at. */
async function attend(userId: string, host: string, n: number) {
  for (let i = 0; i < n; i++) {
    const eventId = await pastNight(host)
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: userId, status: "going" } })
    await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId })
  }
}

const badgesSeenBy = async (viewer: string, subject: string) => {
  const res = await profileRoute.GET(req(`/api/mobile/profiles/${subject}`, tokenOf(viewer)), { params: Promise.resolve({ userId: subject }) })
  const profile = (await res.json()).data.profile as Record<string, unknown>
  return "badges" in profile ? (profile.badges as Array<{ kind: string; label: string }>) : undefined
}

afterAll(async () => {
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.private_messages.deleteMany({ where: { sender_id: { in: users } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
}, 60_000)

describe("who is given someone's badges", () => {
  it("a friend who chose to be recognised, and someone in an open conversation, are; a stranger is not; show_badges off takes them from all", async () => {
    const host = await person("bd-host")
    const subject = await person("bd-subject", { friends_see_me_in_rooms: true })
    await attend(subject, host, 5)

    const friend = await person("bd-friend")
    const [user1_id, user2_id] = [friend, subject].sort()
    await db.friendships.create({ data: { user1_id, user2_id } })
    const talker = await person("bd-talker")
    const [c1, c2] = [talker, subject].sort()
    await db.private_conversations.create({ data: { user1_id: c1, user2_id: c2 } })
    const stranger = await person("bd-stranger")

    const tier = [{ kind: "nights_out", label: "5+ nights this month" }]
    expect(await badgesSeenBy(friend, subject)).toEqual(tier)
    expect(await badgesSeenBy(talker, subject)).toEqual(tier)
    expect(await badgesSeenBy(subject, subject)).toEqual(tier)
    expect(await badgesSeenBy(stranger, subject)).toBeUndefined()

    await db.profiles.update({ where: { id: subject }, data: { show_badges: false } })
    for (const viewer of [friend, talker, subject, stranger]) expect(await badgesSeenBy(viewer, subject)).toBeUndefined()
  })

  it("a friend who did NOT choose to be recognised in rooms still sees them by real id, as the friends page does; the room's handle stays a stranger (SCRUM-863)", async () => {
    const host = await person("bd-host2")
    const subject = await person("bd-subject2")
    await attend(subject, host, 5)
    const friend = await person("bd-friend2")
    const [user1_id, user2_id] = [friend, subject].sort()
    await db.friendships.create({ data: { user1_id, user2_id } })
    expect(await badgesSeenBy(friend, subject)).toEqual([{ kind: "nights_out", label: "5+ nights this month" }])
  })
})

describe('"Shows up"', () => {
  it("is earned by going and turning up, and shown only when the person turned it on", async () => {
    const host = await person("bd-host3")
    const subject = await person("bd-subject3", { shows_up_badge: false })
    await attend(subject, host, 3)

    // Three nights is not five, and the badge is off: nothing earned that is shown.
    expect(await badgesSeenBy(subject, subject)).toEqual([])

    await db.profiles.update({ where: { id: subject }, data: { shows_up_badge: true } })
    expect(await badgesSeenBy(subject, subject)).toEqual([{ kind: "shows_up", label: "Shows up" }])

    // Said they were going and did not turn up: below the rate, so not earned even when it is on.
    const flaky = await person("bd-flaky", { shows_up_badge: true })
    await attend(flaky, host, 1)
    for (let i = 0; i < 2; i++) await db.event_rsvps.create({ data: { event_id: await pastNight(host), user_id: flaky, status: "going" } })
    expect(await badgesSeenBy(flaky, flaky)).toEqual([])
  })
})
