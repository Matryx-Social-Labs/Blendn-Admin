import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { matchesForEvent } from "@/lib/matches"
import { getOccupancy } from "@/lib/occupancy"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/*
 * Two things the door does for a person, driven through the real routes.
 *
 * "Show online status" (SCRUM-141): the switch was written and read by nothing.
 * Off now means counted and not listed — the room's numbers include you, the
 * roster and the grid do not, and someone with no profile row at all is still
 * listed (a relation filter that read NULL as false would drop them).
 *
 * "Why do you go out?" (SCRUM-77): onboarding never wrote `intent_default`, so
 * the board refused every account that came through it. Check-in now says
 * `intentNeeded` at the first door, and stops saying it once the answer is
 * saved as the default — or once this room has an answer of its own.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as
  typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rosterRoute = require("@/app/api/mobile/events/[eventId]/checkins/route") as
  typeof import("@/app/api/mobile/events/[eventId]/checkins/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const prefsRoute = require("@/app/api/mobile/events/[eventId]/matches/preferences/route") as
  typeof import("@/app/api/mobile/events/[eventId]/matches/preferences/route")

const users: string[] = []
const events: string[] = []
const LAT = 12.9784
const LNG = 77.6408

afterAll(async () => {
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function liveEvent() {
  const owner = await makeUser(testId("rv_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("rv"),
      title: "Room visibility fixture",
      description: "integration fixture",
      start_time: new Date(now - 30 * 60_000),
      end_time: new Date(now + 2 * 60 * 60_000),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: owner,
      latitude: LAT,
      longitude: LNG,
      geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 },
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
  })
  return event.id
}

async function attendee(label: string, profile?: { show_online?: boolean; intent_default?: ("friendship" | "networking")[] }) {
  const id = await makeUser(testId(label))
  users.push(id)
  if (profile) await db.profiles.create({ data: { id, name: label, ...profile } })
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, user.email) }
}

const authed = (url: string, token: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const checkIn = (eventId: string, token: string) =>
  checkinRoute.POST(authed(`/api/mobile/events/${eventId}/checkin`, token, "POST", { latitude: LAT, longitude: LNG }), {
    params: Promise.resolve({ eventId }),
  })

const roster = async (eventId: string, token: string) => {
  const res = await rosterRoute.GET(authed(`/api/mobile/events/${eventId}/checkins`, token), {
    params: Promise.resolve({ eventId }),
  })
  const json = await res.json()
  return { ids: (json.data.attendees as { userId: string }[]).map((a) => a.userId).sort(), total: json.data.pagination.totalCount }
}

describe("show online status off", () => {
  it("is counted and not listed — roster, grid, and the count that a page sits under", async () => {
    const eventId = await liveEvent()
    const viewer = await attendee("rv_viewer", { show_online: true })
    const hidden = await attendee("rv_hidden", { show_online: false })
    const shown = await attendee("rv_shown", { show_online: true })
    const bare = await attendee("rv_bare") // no profile row at all
    for (const p of [viewer, hidden, shown, bare]) expect((await checkIn(eventId, p.token)).status).toBe(200)

    // Fire safety counts bodies; the room's number includes them.
    expect((await getOccupancy(eventId)).inside).toBe(4)

    const seen = await roster(eventId, viewer.token)
    expect(seen.ids).toEqual([viewer.id, shown.id, bare.id].sort())
    expect(seen.total).toBe(3)

    const grid = (await matchesForEvent(eventId, viewer.id))!.map((m) => m.userId).sort()
    expect(grid).toEqual([shown.id, bare.id].sort())

    // Symmetric: the hidden person still sees the room they are in.
    expect((await roster(eventId, hidden.token)).ids).toEqual([viewer.id, shown.id, bare.id].sort())
  })
})

describe("why do you go out, asked at the first door", () => {
  it("is asked while there is no default, saved once, and never asked again", async () => {
    const first = await liveEvent()
    const second = await liveEvent()
    const me = await attendee("rv_new", { intent_default: [] })

    const door = await (await checkIn(first, me.token)).json()
    expect(door.data.intentNeeded).toBe(true)

    // The app's answer: this room and the default, in one write.
    const saved = await prefsRoute.PUT(
      authed(`/api/mobile/events/${first}/matches/preferences`, me.token, "PUT", { intent: ["friendship"], rememberIntent: true }),
      { params: Promise.resolve({ eventId: first }) }
    )
    expect(saved.status).toBe(200)
    expect((await db.profiles.findUniqueOrThrow({ where: { id: me.id } })).intent_default).toEqual(["friendship"])

    // Back in for a cigarette: not asked. A different door: not asked.
    expect((await (await checkIn(first, me.token)).json()).data.intentNeeded).toBe(false)
    expect((await (await checkIn(second, me.token)).json()).data.intentNeeded).toBe(false)
  })

  it("is not asked again in a room already answered for, even without a default", async () => {
    const first = await liveEvent()
    const second = await liveEvent()
    const me = await attendee("rv_tonight", { intent_default: [] })
    expect((await (await checkIn(first, me.token)).json()).data.intentNeeded).toBe(true)

    // A one-night answer: this room only.
    await prefsRoute.PUT(
      authed(`/api/mobile/events/${first}/matches/preferences`, me.token, "PUT", { intent: ["just_here"] }),
      { params: Promise.resolve({ eventId: first }) }
    )
    expect((await db.profiles.findUniqueOrThrow({ where: { id: me.id } })).intent_default).toEqual([])

    expect((await (await checkIn(first, me.token)).json()).data.intentNeeded).toBe(false)
    // The next door still has no default to lean on, so it asks.
    expect((await (await checkIn(second, me.token)).json()).data.intentNeeded).toBe(true)
  })

  it("is not asked of someone who already has a default", async () => {
    const eventId = await liveEvent()
    const me = await attendee("rv_set", { intent_default: ["networking"] })
    expect((await (await checkIn(eventId, me.token)).json()).data.intentNeeded).toBe(false)
  })
})
