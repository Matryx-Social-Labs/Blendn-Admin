/*
 * What a host may read of a room (SCRUM-890, 891, 943, 472; owner rows A-5..A-7, A-17).
 *
 * The digest drops a quote it cannot show rather than leaving its mood in feed order. The live snapshot floors a
 * complaint's count, because 0 to 1 lands in the same tick as one pseudonym's message. A rating's bars move every three
 * raters, so a reload does not read the sixth score. A person checked in as staff is out of matching: they neither see
 * the deck nor like nor wave.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
let session: unknown = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session), currentUser: () => Promise.resolve((session as { user?: unknown } | null)?.user ?? null) }))

import { NextRequest } from "next/server"

import { buildFeedbackDigest } from "@/lib/feedback-digest"
import { forVenue } from "@/lib/live-metrics"
import { buildLiveSnapshot } from "@/lib/live-snapshot"
import { occurrenceHereNow } from "@/lib/crews/presence"
import { matchesForEvent } from "@/lib/matches"
import { signAccessToken } from "@/lib/mobile-auth"
import { nightPeople } from "@/lib/night-people"
import { idForViewer } from "@/lib/room-handle"
import { publishedRatingGroups } from "@/lib/rating-batches"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const likes = require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route")
const waves = require("@/app/api/mobile/events/[eventId]/waves/route") as typeof import("@/app/api/mobile/events/[eventId]/waves/route")
const checkins = require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route")
const roster = require("@/app/api/events/[id]/chat/messages/route") as typeof import("@/app/api/events/[id]/chat/messages/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []

afterAll(async () => {
  await db.event_ratings.deleteMany({ where: { event_id: { in: events } } })
  await db.event_feedback.deleteMany({ where: { event_id: { in: events } } })
  await db.event_likes.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.chat_messages.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { owner_org_id: { in: orgs } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function person(label: string, role: "attendee" | "organizer" = "attendee") {
  const id = await makeUser(testId(label), role)
  users.push(id)
  return id
}

/** A room of `size` people, each a member, and the host's event. */
async function roomOf(size: number) {
  const eventId = await makeEvent(await person("hp-host", "organizer"))
  events.push(eventId)
  const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room" } })
  const members: string[] = []
  for (let i = 0; i < size; i++) {
    const id = await person(`hp-m${i}`)
    members.push(id)
    await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: id, anonymous_name: `Pseudo ${i}` } })
  }
  return { eventId, roomId: room.id, members }
}

type Mood = "positive" | "neutral" | "negative"
async function says(eventId: string, roomId: string, userId: string, sentiment: Mood, category: string, text = "words") {
  const message = await db.chat_messages.create({ data: { chat_group_id: roomId, user_id: userId, content: text } })
  await db.event_feedback.create({
    data: { event_id: eventId, message_id: message.id, sentiment, category: category as never, confidence: 0.9, source: "lexicon" as never },
  })
}

const eventRow = (id: string) =>
  db.events.findUniqueOrThrow({ where: { id }, select: { id: true, title: true, end_time: true, timezone: true } })

describe("SCRUM-890: a quote that cannot be shown is not a row", () => {
  it("drops the row, mood and category with it, and keeps the category's total", async () => {
    const { eventId, roomId, members } = await roomOf(10)
    await says(eventId, roomId, members[0], "negative", "safety_conduct", "held back text")
    for (const m of members.slice(1, 6)) await says(eventId, roomId, m, "negative", "entry_queue", "the queue")

    const digest = await buildFeedbackDigest(await eventRow(eventId), "host")

    expect(digest.messages).toHaveLength(5)
    expect(digest.messages.every((m) => m.category === "entry_queue" && m.text === "the queue")).toBe(true)
    expect(digest.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "safety_conduct", count: null, suppressed: true }),
        expect.objectContaining({ category: "entry_queue", count: 5, suppressed: false }),
      ])
    )
    expect(digest.counts.negative).toBe(6)
  })
})

describe("SCRUM-890: the live snapshot floors a complaint's count", () => {
  it("lists it with no number, says so in the alert too, and a venue reads it as quiet", async () => {
    const { eventId, roomId, members } = await roomOf(10)
    const occurrenceId = await occurrenceOf(eventId)
    for (const userId of members) await putInRoom({ eventId, occurrenceId, userId })
    await says(eventId, roomId, members[0], "negative", "safety_conduct")
    for (const m of members.slice(1, 6)) await says(eventId, roomId, m, "negative", "entry_queue")

    const snapshot = (await buildLiveSnapshot(eventId))!

    expect(snapshot.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "safety_conduct", count: null, suppressed: true }),
        expect.objectContaining({ category: "entry_queue", count: 5, suppressed: false }),
      ])
    )
    const alert = snapshot.alerts.find((a) => a.kind === "safety")!
    expect(alert).toBeDefined()
    expect(alert.body).not.toMatch(/\d/)
    expect(snapshot.alerts.every((a) => !/\d+ (safety|entry)/.test(a.body))).toBe(true)
    expect(forVenue(snapshot).categories).toEqual(
      expect.arrayContaining([
        { category: "safety_conduct", count: "quiet" },
        { category: "entry_queue", count: "5-9" },
      ])
    )
  })
})

describe("SCRUM-472: a night's bars move every three raters", () => {
  async function rated(n: number) {
    const eventId = await makeEvent(await person("hp-rh", "organizer"))
    events.push(eventId)
    const rate = async (rating: number, i: number) => {
      await db.event_ratings.create({
        data: { event_id: eventId, user_id: await person(`hp-r${i}`), rating, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)) },
      })
    }
    return { eventId, rate, n }
  }

  it("holds the bars from the fifth to the seventh, and moves them on the eighth", async () => {
    const { eventId, rate } = await rated(8)
    for (const [i, s] of [5, 5, 5, 5, 5].entries()) await rate(s, i)
    const fifth = await buildFeedbackDigest(await eventRow(eventId), "host")
    expect(fifth).toMatchObject({ ratings: [0, 0, 0, 0, 5], averageRating: 5, ratingCount: 5, ratingsTowardNextUpdate: 0 })

    // The sixth is a one: the difference would be that person's score.
    await rate(1, 5)
    const sixth = await buildFeedbackDigest(await eventRow(eventId), "host")
    expect(sixth).toMatchObject({ ratings: [0, 0, 0, 0, 5], averageRating: 5, ratingCount: 6, ratingsTowardNextUpdate: 1 })

    await rate(2, 6)
    expect(await buildFeedbackDigest(await eventRow(eventId), "host")).toMatchObject({ ratings: [0, 0, 0, 0, 5], ratingCount: 7, ratingsTowardNextUpdate: 2 })

    await rate(3, 7)
    const eighth = await buildFeedbackDigest(await eventRow(eventId), "host")
    expect(eighth).toMatchObject({ ratings: [1, 1, 1, 0, 5], ratingCount: 8, ratingsTowardNextUpdate: 0 })
  })

  it("tells a venue nothing finer than the published count", async () => {
    const { eventId, rate } = await rated(7)
    for (const [i, s] of [4, 4, 4, 4, 4, 1].entries()) await rate(s, i)
    const venue = await buildFeedbackDigest(await eventRow(eventId), "venue")
    expect(venue).toMatchObject({ ratings: [0, 0, 0, 5, 0], ratingCount: 5, ratingsTowardNextUpdate: null })
  })

  it("the shared read groups only what is published, per event, under the floor included", async () => {
    const a = await rated(6)
    const b = await rated(2)
    for (const [i, s] of [3, 3, 3, 3, 3, 1].entries()) await a.rate(s, i)
    for (const [i, s] of [2, 2].entries()) await b.rate(s, i)
    const rows = await publishedRatingGroups({ id: { in: [a.eventId, b.eventId] } })
    expect(rows).toEqual(
      expect.arrayContaining([
        { event_id: a.eventId, rating: 3, _count: { _all: 5 } },
        { event_id: b.eventId, rating: 2, _count: { _all: 2 } },
      ])
    )
    expect(rows).toHaveLength(2)
    await expect(publishedRatingGroups({ id: { in: [] } })).resolves.toEqual([])
  })
})

describe("SCRUM-891 / 943: someone checked in as staff is out of matching", () => {
  async function staffAndGuest() {
    const eventId = await makeEvent(await person("hp-sh", "organizer"))
    events.push(eventId)
    const occurrenceId = await occurrenceOf(eventId)
    const crew = await person("hp-crew")
    const guest = await person("hp-guest")
    await putInRoom({ eventId, occurrenceId, userId: crew, kind: "staff" })
    await putInRoom({ eventId, occurrenceId, userId: guest })
    return { eventId, crew, guest }
  }
  const post = (handler: unknown, eventId: string, as: string, body: unknown) =>
    (handler as (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>)(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/x`, {
        method: "POST",
        headers: { authorization: `Bearer ${signAccessToken(as, `${as}@itest.invalid`)}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ eventId }) }
    )

  it("has no deck, no people from tonight, no like and no wave", async () => {
    const { eventId, crew, guest } = await staffAndGuest()
    expect(await matchesForEvent(eventId, crew)).toBeNull()
    expect(await nightPeople(eventId, crew)).toEqual({ refused: "not_attended" })
    const ref = idForViewer(crew, eventId, guest)
    expect((await post(likes.POST, eventId, crew, { userId: ref })).status).toBe(403)
    expect((await post(waves.POST, eventId, crew, { toUserId: ref })).status).toBe(403)
    expect(await db.event_likes.count({ where: { event_id: eventId, liker_id: crew } })).toBe(0)
  })

  it("nobody waves at staff, and staff read no roster", async () => {
    const { eventId, crew, guest } = await staffAndGuest()
    const toCrew = idForViewer(guest, eventId, crew)
    expect((await post(waves.POST, eventId, guest, { toUserId: toCrew })).status).not.toBe(201)
    const read = (as: string) =>
      checkins.GET(
        new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkins`, { headers: { authorization: `Bearer ${signAccessToken(as, `${as}@itest.invalid`)}` } }),
        { params: Promise.resolve({ eventId }) }
      )
    expect(await (await read(crew)).json()).toMatchObject({ data: { attendees: [] } })
    expect((await (await read(guest)).json()).data.attendees).toBeDefined()
  })

  it("the latest row decides: a guest on Monday who is staff on Tuesday is out", async () => {
    const eventId = await makeEvent(await person("hp-sh2", "organizer"))
    events.push(eventId)
    const occurrenceId = await occurrenceOf(eventId)
    const crew = await person("hp-crew2")
    await putInRoom({ eventId, occurrenceId, userId: crew, at: new Date(Date.now() - 86_400_000) })
    await db.event_check_ins.updateMany({ where: { event_id: eventId, user_id: crew }, data: { status: "checked_out", check_out_time: new Date(Date.now() - 80_000_000) } })
    const tuesday = await db.event_occurrences.create({
      data: { event_id: eventId, occurs_on: new Date(Date.now() + 86_400_000), start_time: new Date(), end_time: new Date(Date.now() + 3_600_000) },
    })
    await putInRoom({ eventId, occurrenceId: tuesday.id, userId: crew, kind: "staff" })
    expect(await matchesForEvent(eventId, crew)).toBeNull()
    expect(await nightPeople(eventId, crew)).toEqual({ refused: "not_attended" })
  })

  it("a staff member's crew is not here through them, and they cannot like as it", async () => {
    const { eventId, crew } = await staffAndGuest()
    expect(await occurrenceHereNow(eventId, crew)).toBeNull()
  })

  it("a guest in the same room keeps all of it (negative control)", async () => {
    const { eventId, guest } = await staffAndGuest()
    expect(await matchesForEvent(eventId, guest)).not.toBeNull()
    expect(await nightPeople(eventId, guest)).toMatchObject({ open: true })
  })
})

describe("SCRUM-891: a venue owner's room header is a range", () => {
  it("is 'Under 5' for a venue owner and the exact count for the host", async () => {
    const owner = await person("hp-vo", "organizer")
    const host = await person("hp-vh", "organizer")
    const org = await db.organisations.create({ data: { display_name: testId("vorg"), kind: "company", status: "verified" } })
    orgs.push(org.id)
    await db.organisation_members.create({ data: { org_id: org.id, user_id: owner, role: "owner" } })
    const venue = await db.venues.create({ data: { name: testId("V"), city: "Bengaluru", latitude: 12.97, longitude: 77.64, timezone: "UTC", day_reset_hour: 6, owner_org_id: org.id, claimed_at: new Date(Date.now() - 60 * 86_400_000) } })
    const eventId = await makeEvent(host)
    events.push(eventId)
    const hostOrg = await db.organisations.create({ data: { display_name: testId("horg"), kind: "company", status: "verified" } })
    orgs.push(hostOrg.id)
    await db.organisation_members.create({ data: { org_id: hostOrg.id, user_id: host, role: "owner" } })
    await db.events.update({ where: { id: eventId }, data: { venue_id: venue.id, organizer_org_id: hostOrg.id } })
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
    const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room" } })
    const member = await person("hp-vm")
    await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: member, anonymous_name: "P" } })
    const read = async (as: string) => {
      session = { user: { id: as, role: as === owner ? "venue_owner" : "organizer" } }
      const res = await roster.GET(new NextRequest(`http://localhost/api/events/${eventId}/chat/messages`), { params: Promise.resolve({ id: eventId }) })
      expect(res.status).toBe(200)
      return (await res.json()) as { activeCount: unknown }
    }
    expect((await read(owner)).activeCount).toBe("Under 5")
    expect((await read(host)).activeCount).toBe(1)
  })
})
