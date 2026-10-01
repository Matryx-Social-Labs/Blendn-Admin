import { randomUUID } from "crypto"
import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { db as appDb } from "@/lib/db"
import { signAccessToken } from "@/lib/mobile-auth"
import { canJoinChat, canJoinEvent, canJoinEventRoom } from "@/lib/socket-auth"
import { refusalsByReason, refusalSummary } from "@/lib/check-in-refusals"
import { sweepPresence, sweepVenueDays } from "@/lib/presence-sweeper"
import { SYSTEM_USER_ID } from "@/lib/venue-day"

import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const liveRoute = require("@/app/api/mobile/venues/[venueId]/live/route") as typeof import("@/app/api/mobile/venues/[venueId]/live/route")
const venueRoute = require("@/app/api/mobile/venues/[venueId]/route") as typeof import("@/app/api/mobile/venues/[venueId]/route")
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
const rsvpRoute = require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
const favoriteRoute = require("@/app/api/mobile/events/[eventId]/favorite/route") as typeof import("@/app/api/mobile/events/[eventId]/favorite/route")
const interestRoute = require("@/app/api/mobile/events/[eventId]/interest/route") as typeof import("@/app/api/mobile/events/[eventId]/interest/route")
const ratingRoute = require("@/app/api/mobile/events/[eventId]/rating/route") as typeof import("@/app/api/mobile/events/[eventId]/rating/route")
const presenceRoute = require("@/app/api/mobile/events/[eventId]/presence/route") as typeof import("@/app/api/mobile/events/[eventId]/presence/route")
const eventChatRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
const rosterRoute = require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route")
const messagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const attendanceRoute = require("@/app/api/mobile/me/attendance/route") as typeof import("@/app/api/mobile/me/attendance/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Go Live, driven end to end against real Postgres (plan v2 step 4; TQ-A08,
 * TQ-B05). Every route is the real handler with a real JWT.
 *
 * Time: the routes read the wall clock, so a window is made to have ended by
 * moving its rows back (`rewind`) rather than by waiting — the same instant,
 * arrived at honestly, and never a sleep.
 */

const LAT = 12.9784
const LNG = 77.6408
const INSIDE = { latitude: LAT, longitude: LNG }
const OUTSIDE = { latitude: LAT + 0.01, longitude: LNG } // ~1.1 km north
const FENCE = { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 }

const users: string[] = []
const venues: string[] = []
const orgs: string[] = []

afterAll(async () => {
  const rows = await db.events.findMany({ where: { venue_id: { in: venues } }, select: { id: true } })
  const ids = rows.map((r) => r.id)
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: ids } } })
  await cleanup([], ids)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
}, 120_000)

async function person(label = "gl") {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

/**
 * A venue at the fixture point. Its day resets twelve hours from now unless a
 * test says otherwise, so no window in these tests is cut short by the reset
 * at whatever hour the suite happens to run (the reset test sets its own).
 */
async function venue(opts: { fence?: object | null; ownerOrg?: string; timezone?: string; resetHour?: number } = {}) {
  const row = await db.venues.create({
    data: {
      name: testId("Venue"),
      city: "Bengaluru",
      latitude: LAT,
      longitude: LNG,
      ...(opts.fence !== null && { geofence: opts.fence ?? FENCE }),
      ...(opts.ownerOrg && { owner_org_id: opts.ownerOrg, claimed_at: new Date(Date.now() - 86_400_000) }),
      timezone: opts.timezone ?? "UTC",
      day_reset_hour: opts.resetHour ?? (new Date().getUTCHours() + 12) % 24,
    },
  })
  venues.push(row.id)
  return row.id
}

/** A real event at the venue, on or starting in `startsInMin`. */
async function realEvent(venueId: string, opts: {
  startsInMin: number
  visibility?: "public" | "private"
  link?: "confirmed" | "disputed" | null
  minAge?: number
}) {
  const host = await makeUser(testId("gl_host"), "organizer")
  users.push(host)
  const start = new Date(Date.now() + opts.startsInMin * 60_000)
  const end = new Date(start.getTime() + 3 * 3_600_000)
  const event = await db.events.create({
    data: {
      slug: testId("gl_evt"),
      title: testId("Jazz Night"),
      description: "integration fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "published",
      visibility: opts.visibility ?? "public",
      organizer_id: host,
      venue_id: venueId,
      venue_link_status: opts.link === undefined ? null : opts.link,
      min_age: opts.minAge ?? null,
      latitude: LAT,
      longitude: LNG,
      geofence: FENCE,
    },
  })
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  return event.id
}

const req = (url: string, token: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

async function goLive(token: string, venueId: string, body: object = { minutes: 20 }, at = INSIDE) {
  const res = await liveRoute.POST(req(`/api/mobile/venues/${venueId}/live`, token, "POST", { ...at, ...body }), {
    params: Promise.resolve({ venueId }),
  })
  return { status: res.status, json: await res.json() }
}

const eventParams = (eventId: string) => ({ params: Promise.resolve({ eventId }) })

/** Move a Go Live back in time by `minutes`: as if it had started that long ago. */
async function rewind(eventId: string, userId: string, minutes: number) {
  await db.$executeRaw`
    UPDATE event_check_ins
       SET check_in_time = check_in_time - make_interval(mins => ${minutes}),
           created_at = created_at - make_interval(mins => ${minutes}),
           expires_at = expires_at - make_interval(mins => ${minutes}),
           stay_until = stay_until - make_interval(mins => ${minutes})
     WHERE event_id = ${eventId}::uuid AND user_id = ${userId}`
  await db.$executeRaw`
    UPDATE presence_sessions
       SET arrived_at = arrived_at - make_interval(mins => ${minutes}),
           last_seen_at = last_seen_at - make_interval(mins => ${minutes})
     WHERE event_id = ${eventId}::uuid AND user_id = ${userId}`
  await db.$executeRaw`
    UPDATE chat_group_members m
       SET last_allowed_at = last_allowed_at - make_interval(mins => ${minutes})
      FROM chat_groups g
     WHERE g.id = m.chat_group_id AND g.event_id = ${eventId}::uuid AND m.user_id = ${userId}`
}

const checkInOf = (eventId: string, userId: string) =>
  db.event_check_ins.findFirstOrThrow({ where: { event_id: eventId, user_id: userId } })
const sessionOf = (eventId: string, userId: string) =>
  db.presence_sessions.findFirstOrThrow({ where: { event_id: eventId, user_id: userId }, orderBy: { arrived_at: "desc" } })

describe("POST /venues/:id/live", () => {
  it("opens a window: a check-in with expires_at, a session, and the room until then", async () => {
    const v = await venue()
    const me = await person()
    const before = Date.now()
    const { status, json } = await goLive(me.token, v, { minutes: 20 })
    expect(status).toBe(200)

    const { venueDayId, chatGroupId, expiresAt, stay } = json.data
    expect(stay).toBe(false)
    const expires = new Date(expiresAt).getTime()
    expect(expires - before).toBeGreaterThanOrEqual(20 * 60_000 - 1_000)
    expect(expires - before).toBeLessThanOrEqual(20 * 60_000 + 5_000)

    const day = await db.events.findUniqueOrThrow({ where: { id: venueDayId } })
    expect(day).toMatchObject({ kind: "venue_day", venue_id: v, organizer_id: SYSTEM_USER_ID, organizer_org_id: null })

    const checkIn = await checkInOf(venueDayId, me.id)
    expect(checkIn).toMatchObject({ status: "checked_in", kind: "attendee", stay_until: null })
    expect(checkIn.expires_at?.toISOString()).toBe(expiresAt)
    // `openSession` is not awaited by the door; give it its round trip.
    await new Promise((r) => setTimeout(r, 300))
    expect((await sessionOf(venueDayId, me.id)).departed_at).toBeNull()

    const member = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: me.id } },
    })
    expect(member.last_allowed_at?.toISOString()).toBe(expiresAt)
    expect(await canJoinChat(me.id, chatGroupId)).toBe(true)
  })

  it("makes one venue day when ten go live at once, and seats all ten (PL-I01)", async () => {
    const v = await venue()
    const people = await Promise.all(Array.from({ length: 10 }, () => person("gl10")))
    const results = await Promise.all(people.map((p) => goLive(p.token, v)))
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200))
    expect(new Set(results.map((r) => r.json.data.venueDayId)).size).toBe(1)
    expect(await db.events.count({ where: { venue_id: v, kind: "venue_day" } })).toBe(1)
    expect(await db.event_check_ins.count({ where: { event_id: results[0].json.data.venueDayId, status: "checked_in" } })).toBe(10)
  })

  it("reads the room back when it loses the race to make it (forced)", async () => {
    // Ten at once lose that race only sometimes; this always does. The room
    // exists, the lookup is made to miss once, so the create collides on
    // `chat_groups_event_id_key` and the door must read the winner's room.
    const v = await venue()
    const [a, b] = [await person(), await person()]
    const first = await goLive(a.token, v)
    const spy = jest.spyOn(appDb.chat_groups, "findUnique").mockResolvedValueOnce(null)
    try {
      const second = await goLive(b.token, v)
      expect(second.status).toBe(200)
      expect(second.json.data.chatGroupId).toBe(first.json.data.chatGroupId)
    } finally {
      spy.mockRestore()
    }
  })

  it("refuses any other window (PL-U02)", async () => {
    const v = await venue()
    const me = await person()
    expect((await goLive(me.token, v, { minutes: 30 })).status).toBe(400)
    expect((await goLive(me.token, v, {})).status).toBe(400)
  })

  it("extends when you go live again, and never shortens", async () => {
    const v = await venue()
    const me = await person()
    const first = await goLive(me.token, v, { minutes: 60 })
    const again = await goLive(me.token, v, { minutes: 20 })
    expect(again.json.data.expiresAt).toBe(first.json.data.expiresAt)
    expect(await db.event_check_ins.count({ where: { event_id: first.json.data.venueDayId, user_id: me.id } })).toBe(1)
  })

  it("ends a window at the venue's reset, as expired (D-4)", async () => {
    // A venue whose day resets at the top of the next UTC hour: a 60-minute
    // window asked for now must stop there.
    const resetHour = (new Date().getUTCHours() + 1) % 24
    const v = await venue({ timezone: "UTC", resetHour })
    const me = await person()
    const { json } = await goLive(me.token, v, { minutes: 60 })
    const day = await db.events.findUniqueOrThrow({ where: { id: json.data.venueDayId } })
    expect(json.data.expiresAt).toBe(day.end_time.toISOString())
  })

  it("is staff work for the venue's own organisation, as at an event there (decision)", async () => {
    const org = await db.organisations.create({ data: { display_name: testId("gl_org"), kind: "company", status: "verified" } })
    orgs.push(org.id)
    const v = await venue({ ownerOrg: org.id })
    const me = await person()
    await db.organisation_members.create({ data: { org_id: org.id, user_id: me.id, role: "owner" } })
    const { json } = await goLive(me.token, v, { stay: true })
    const dayId = json.data.venueDayId
    expect((await checkInOf(dayId, me.id)).kind).toBe("staff")

    // Staff skip the fence in the departure rule; their "stay" still follows an in-fence ping.
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: me.id }, data: { expires_at: new Date(Date.now() + 2 * 60_000) } })
    await presenceRoute.POST(req(`/api/mobile/events/${dayId}/presence`, me.token, "POST", { ...INSIDE, accuracy: 10 }), eventParams(dayId))
    expect((await checkInOf(dayId, me.id)).expires_at!.getTime() - Date.now()).toBeGreaterThan(15 * 60_000)
  })

  it("refuses an unfenced venue and records it on the day (PL-I12, PL-I19)", async () => {
    const v = await venue({ fence: null })
    const me = await person()
    const { status, json } = await goLive(me.token, v)
    expect(status).toBe(400)
    expect(json.errorCode).toBe("OUT_OF_RANGE")
    const day = await db.events.findFirstOrThrow({ where: { venue_id: v, kind: "venue_day" } })
    await new Promise((r) => setTimeout(r, 300))
    expect(await db.check_in_refusals.count({ where: { event_id: day.id, user_id: me.id, reason: "no_geofence" } })).toBe(1)
  })

  it("refuses outside the fence, recorded against the venue day and nowhere else (PL-I19)", async () => {
    const v = await venue()
    const eventHere = await realEvent(v, { startsInMin: 6 * 60 })
    const me = await person()
    const since = new Date(Date.now() - 1_000)
    const platformBefore = await refusalsByReason({ from: since, to: new Date(Date.now() + 60_000) })
    const { status } = await goLive(me.token, v, { minutes: 20 }, OUTSIDE)
    expect(status).toBe(400)
    const day = await db.events.findFirstOrThrow({ where: { venue_id: v, kind: "venue_day" } })
    await new Promise((r) => setTimeout(r, 300))
    expect(await db.check_in_refusals.count({ where: { event_id: day.id, reason: "out_of_range" } })).toBe(1)
    // Not the organiser's Turned-away panel for the event at the same venue,
    // and not the platform's turned-away-at-events figure.
    expect((await refusalSummary(eventHere)).attempts).toBe(0)
    expect((await refusalsByReason({ from: since, to: new Date(Date.now() + 60_000) })).total).toBe(platformBefore.total)
  })

  it("refuses a venue that is archived or unknown with 404", async () => {
    const v = await venue()
    await db.venues.update({ where: { id: v }, data: { status: "archived" } })
    const me = await person()
    expect((await goLive(me.token, v)).status).toBe(404)
    expect((await goLive(me.token, randomUUID())).status).toBe(404)

    // Today's room deleted by an admin stays closed for the day.
    const w = await venue()
    const first = await goLive(me.token, w)
    await db.events.update({ where: { id: first.json.data.venueDayId }, data: { deleted_at: new Date() } })
    const other = await person()
    expect((await goLive(other.token, w)).status).toBe(404)
  })

  it("refuses somebody who has not finished onboarding (18+)", async () => {
    const v = await venue()
    const id = await makeUser(testId("gl_new"))
    users.push(id)
    const { status } = await goLive(signAccessToken(id, `${id}@itest.invalid`), v)
    expect(status).toBe(403)
  })

  it("closes a switch: live at A, then an event, then live at C (PL-I11)", async () => {
    const [a, c] = [await venue(), await venue()]
    const me = await person()
    const atA = await goLive(me.token, a)
    const eventB = await realEvent(await venue({ fence: FENCE }), { startsInMin: -10, visibility: "private" })
    await db.event_rsvps.create({ data: { event_id: eventB, user_id: me.id, status: "going" } })
    const res = await checkinRoute.POST(req(`/api/mobile/events/${eventB}/checkin`, me.token, "POST", INSIDE), eventParams(eventB))
    expect(res.status).toBe(200)
    expect((await checkInOf(atA.json.data.venueDayId, me.id)).status).toBe("checked_out")
    expect((await sessionOf(atA.json.data.venueDayId, me.id)).departed_source).toBe("switch")
    // The switch cut the venue room too.
    expect(await canJoinChat(me.id, atA.json.data.chatGroupId)).toBe(false)

    await goLive(me.token, c)
    expect((await checkInOf(eventB, me.id)).status).toBe("checked_out")
  })
})

describe("EVENT_LIVE_HERE (PL-I09)", () => {
  it.each([
    ["public, published, linked (NULL link)", { link: null }, 409],
    ["public, confirmed link", { link: "confirmed" as const }, 409],
    ["private", { visibility: "private" as const, link: null }, 200],
    ["disputed", { link: "disputed" as const }, 200],
  ])("an event here starting in 59 minutes: %s → %s", async (_label, opts, expected) => {
    const v = await venue()
    const eventId = await realEvent(v, { startsInMin: 59, ...opts })
    const me = await person()
    const { status, json } = await goLive(me.token, v)
    expect(status).toBe(expected)
    if (expected === 409) {
      expect(json).toMatchObject({ errorCode: "EVENT_LIVE_HERE", eventId })
      // A refusal before any day: nothing was made.
      expect(await db.events.count({ where: { venue_id: v, kind: "venue_day" } })).toBe(0)
    }
  })

  it("does not refuse for an event more than an hour away", async () => {
    const v = await venue()
    await realEvent(v, { startsInMin: 61 })
    const me = await person()
    expect((await goLive(me.token, v)).status).toBe(200)
  })
})

describe("by-id attendee routes refuse a venue day's id", () => {
  it("as if it did not exist", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v)
    const id = json.data.venueDayId
    const other = await person()

    expect((await eventRoute.GET(req(`/api/mobile/events/${id}`, other.token), eventParams(id))).status).toBe(404)
    expect((await rsvpRoute.POST(req(`/api/mobile/events/${id}/rsvp`, other.token, "POST", { status: "going" }), eventParams(id))).status).toBe(404)
    expect((await favoriteRoute.POST(req(`/api/mobile/events/${id}/favorite`, other.token, "POST"), eventParams(id))).status).toBe(404)
    expect((await interestRoute.POST(req(`/api/mobile/events/${id}/interest`, other.token, "POST", {}), eventParams(id))).status).toBe(404)
    expect((await ratingRoute.POST(req(`/api/mobile/events/${id}/rating`, me.token, "POST", { rating: 5 }), eventParams(id))).status).toBe(404)
    expect((await ratingRoute.GET(req(`/api/mobile/events/${id}/rating`, me.token), eventParams(id))).status).toBe(404)
    // The plain check-in is not a door into a venue day: Go Live is.
    expect((await checkinRoute.POST(req(`/api/mobile/events/${id}/checkin`, other.token, "POST", INSIDE), eventParams(id))).status).toBe(404)
    expect(await db.event_check_ins.count({ where: { event_id: id, user_id: other.id } })).toBe(0)
    expect(await db.event_rsvps.count({ where: { event_id: id } })).toBe(0)
  })
})

describe("the venue's room is for the people live in it (F6, F7, D-5)", () => {
  it("closes to you when your window ends, on every door", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v)
    const { venueDayId, chatGroupId } = json.data

    // Live: the room reads and takes a message.
    const send = (token: string) =>
      messagesRoute.POST(req(`/api/mobile/chat/groups/${chatGroupId}/messages`, token, "POST", { content: "hello" }), {
        params: Promise.resolve({ chatGroupId }),
      })
    const read = (token: string) =>
      messagesRoute.GET(req(`/api/mobile/chat/groups/${chatGroupId}/messages`, token), { params: Promise.resolve({ chatGroupId }) })
    expect((await read(me.token)).status).toBe(200)
    expect(await canJoinEventRoom(me.id, venueDayId)).toBe(true)
    expect((await rosterRoute.GET(req(`/api/mobile/events/${venueDayId}/checkins`, me.token), eventParams(venueDayId))).status).toBe(200)

    // The window ends (20 minutes ago it started 25 minutes ago).
    await rewind(venueDayId, me.id, 25)

    // Closed at the end itself, before any sweeper has run: the doors compare
    // the window with the clock (`liveInVenueDay`, `inRoomWhere`).
    expect((await checkInOf(venueDayId, me.id)).status).toBe("checked_in")
    expect(await canJoinChat(me.id, chatGroupId)).toBe(false)
    expect(await canJoinEventRoom(me.id, venueDayId)).toBe(false)
    expect((await rosterRoute.GET(req(`/api/mobile/events/${venueDayId}/checkins`, me.token), eventParams(venueDayId))).status).toBe(403)

    const swept = await sweepVenueDays()
    expect(swept.expired).toBeGreaterThanOrEqual(1)

    const checkIn = await checkInOf(venueDayId, me.id)
    const session = await sessionOf(venueDayId, me.id)
    expect(checkIn.status).toBe("checked_out")
    expect(session.departed_source).toBe("expired")
    // Stamped when the window ended, not when the sweeper got there (PL-U04).
    expect(session.departed_at?.toISOString()).toBe(checkIn.expires_at?.toISOString())

    expect(await canJoinChat(me.id, chatGroupId)).toBe(false)
    expect(await canJoinEventRoom(me.id, venueDayId)).toBe(false)
    expect(await canJoinEvent(me.id, venueDayId)).toBe(false)
    const readAfter = await read(me.token)
    expect(readAfter.status).toBe(403)
    expect((await readAfter.json()).errorCode).toBe("NOT_LIVE")
    const sendAfter = await send(me.token)
    expect(sendAfter.status).toBe(403)
    expect((await sendAfter.json()).errorCode).toBe("NOT_LIVE")
    expect((await rosterRoute.GET(req(`/api/mobile/events/${venueDayId}/checkins`, me.token), eventParams(venueDayId))).status).toBe(403)
    const viaEvent = await eventChatRoute.GET(req(`/api/mobile/events/${venueDayId}/chat`, me.token), eventParams(venueDayId))
    expect(viaEvent.status).toBe(403)
  })

  it("never lets somebody in who was not live there (no auto-join)", async () => {
    const v = await venue()
    const host = await person()
    const { json } = await goLive(host.token, v)
    const stranger = await person()
    const res = await eventChatRoute.GET(req(`/api/mobile/events/${json.data.venueDayId}/chat`, stranger.token), eventParams(json.data.venueDayId))
    expect(res.status).toBe(403)
    // "Go live", not "RSVP": an RSVP is no way into a venue's room (F7).
    expect((await res.json()).errorCode).toBe("NOT_LIVE")
    expect(await db.chat_group_members.count({ where: { chat_group_id: json.data.chatGroupId, user_id: stranger.id } })).toBe(0)
    expect(await canJoinEvent(stranger.id, json.data.venueDayId)).toBe(false)
  })
})

describe("the venue-day sweeper (TQ-B05)", () => {
  /** `n` people live at one venue day, written directly: the door is tested above. */
  async function crowd(n: number, opts: { expiresInMin: number; leftAreaMinAgo?: number; count?: number }) {
    const v = await venue()
    const first = await person("glc")
    const { json } = await goLive(first.token, v, { minutes: 60 })
    const dayId = json.data.venueDayId as string
    // The door's session write is not awaited; let it land before replacing it.
    await new Promise((r) => setTimeout(r, 300))
    const day = await db.events.findUniqueOrThrow({ where: { id: dayId }, select: { occurrences: { select: { id: true } } } })
    const occurrenceId = day.occurrences[0].id
    const ids: string[] = [first.id]
    for (let i = 1; i < n; i++) {
      const id = await makeUser(testId("glc"))
      users.push(id)
      ids.push(id)
    }
    const arrived = new Date(Date.now() - 90 * 60_000)
    const expires = new Date(Date.now() + opts.expiresInMin * 60_000)
    await db.event_check_ins.deleteMany({ where: { event_id: dayId } })
    await db.presence_sessions.deleteMany({ where: { event_id: dayId } })
    const leftCount = opts.count ?? 0
    await db.event_check_ins.createMany({
      data: ids.map((user_id, i) => ({
        event_id: dayId,
        occurrence_id: occurrenceId,
        user_id,
        status: "checked_in" as const,
        check_in_time: arrived,
        expires_at: expires,
        last_seen_at: arrived,
        ...(i < leftCount && opts.leftAreaMinAgo !== undefined && { left_area_at: new Date(Date.now() - opts.leftAreaMinAgo * 60_000) }),
      })),
    })
    await db.presence_sessions.createMany({
      data: ids.map((user_id) => ({ event_id: dayId, occurrence_id: occurrenceId, user_id, arrived_at: arrived, last_seen_at: arrived })),
    })
    return { dayId, ids, venueId: v }
  }

  it("expires fifty windows that end together without tripping the breaker (PL-I04, D-20)", async () => {
    const { dayId } = await crowd(50, { expiresInMin: -1 })
    const result = await sweepVenueDays()
    expect(result.expired).toBeGreaterThanOrEqual(50)
    expect(result.rooms.guarded).not.toContain(dayId)
    expect(await db.event_check_ins.count({ where: { event_id: dayId, status: "checked_in" } })).toBe(0)
    expect(await db.presence_sessions.count({ where: { event_id: dayId, departed_source: "expired" } })).toBe(50)
  })

  it("still trips the breaker on an out-of-fence burst at a venue day (PL-I05)", async () => {
    // 6 of 8 out of the fence for longer than the allowance, windows still open.
    const { dayId } = await crowd(8, { expiresInMin: 30, leftAreaMinAgo: 30, count: 6 })
    const result = await sweepVenueDays()
    expect(result.rooms.guarded).toContain(dayId)
    expect(await db.event_check_ins.count({ where: { event_id: dayId, status: "checked_in" } })).toBe(8)
  })

  it("closes the venue's sessions when a public event there starts, and pushes each person once (PL-I10)", async () => {
    const v = await venue()
    const people = [await person("gls"), await person("gls"), await person("gls")]
    const live = await Promise.all(people.map((p) => goLive(p.token, v, { minutes: 60 })))
    const dayId = live[0].json.data.venueDayId as string
    const eventId = await realEvent(v, { startsInMin: -1 })
    const title = (await db.events.findUniqueOrThrow({ where: { id: eventId } })).title

    // And a private event starting at another venue with someone live: nothing.
    const quiet = await venue()
    const bystander = await person("gls")
    const quietLive = await goLive(bystander.token, quiet, { minutes: 60 })
    await realEvent(quiet, { startsInMin: -1, visibility: "private" })

    const first = await sweepVenueDays()
    expect(first.closedForEvents).toBeGreaterThanOrEqual(3)
    for (const p of people) {
      expect((await checkInOf(dayId, p.id)).status).toBe("checked_out")
      expect((await sessionOf(dayId, p.id)).departed_source).toBe("ended")
      // And out of the room now, though their window had time left (PL-K04).
      expect(await canJoinChat(p.id, live[0].json.data.chatGroupId)).toBe(false)
    }
    const notes = await db.notifications.findMany({ where: { user_id: { in: people.map((p) => p.id) } } })
    expect(notes).toHaveLength(3)
    for (const n of notes) {
      expect(n.kind).toBe("event_update")
      expect(n.body).toContain(title)
      expect(n.data).toMatchObject({ eventId })
    }
    // Names nobody: no person's name is in what was sent.
    const names = (await db.user.findMany({ where: { id: { in: people.map((p) => p.id) } }, select: { name: true } })).map((u) => u.name!)
    for (const n of notes) for (const name of names) expect(`${n.title} ${n.body}`).not.toContain(name)

    expect((await checkInOf(quietLive.json.data.venueDayId, bystander.id)).status).toBe("checked_in")
    expect(await db.notifications.count({ where: { user_id: bystander.id } })).toBe(0)

    // Once each: a second pass finds them already out.
    await sweepVenueDays()
    expect(await db.notifications.count({ where: { user_id: { in: people.map((p) => p.id) } } })).toBe(3)
  })

  it("leaves somebody too young for the event live, and closes the rest (D-3)", async () => {
    const [young, older] = [await person("gly"), await person("glo")]
    const born = (years: number) => new Date(Date.now() - (years * 365.25 + 30) * 86_400_000)
    await db.profiles.update({ where: { id: young.id }, data: { date_of_birth: born(19) } })
    await db.profiles.update({ where: { id: older.id }, data: { date_of_birth: born(25) } })

    // Go Live is not refused in favour of a 21+ event they could not enter.
    const soon = await venue()
    await realEvent(soon, { startsInMin: 30, minAge: 21 })
    expect((await goLive(young.token, soon)).status).toBe(200)
    expect((await goLive(older.token, soon)).status).toBe(409)

    // Both live somewhere quiet; then a 21+ event starts there.
    const v = await venue()
    const [y, o] = [await goLive(young.token, v, { minutes: 60 }), await goLive(older.token, v, { minutes: 60 })]
    expect([y.status, o.status]).toEqual([200, 200])
    const eventId = await realEvent(v, { startsInMin: -1, minAge: 21 })
    await sweepVenueDays()
    const dayId = y.json.data.venueDayId
    expect((await checkInOf(dayId, young.id)).status).toBe("checked_in")
    expect((await checkInOf(dayId, older.id)).status).toBe("checked_out")
    const told = async (id: string) =>
      db.notifications.count({ where: { user_id: id, data: { path: ["eventId"], equals: eventId } } })
    expect(await told(young.id)).toBe(0)
    expect(await told(older.id)).toBe(1)
  })

  it("does not let 300 venue days starve a real event (PL-I06, F5)", async () => {
    const runner = await makeUser(testId("gl300"))
    users.push(runner)
    const older = new Date(Date.now() - 3 * 3_600_000)
    const now = Date.now()
    const venueRows = Array.from({ length: 300 }, () => ({ id: randomUUID(), name: testId("V300"), latitude: LAT, longitude: LNG, geofence: FENCE }))
    await db.venues.createMany({ data: venueRows })
    venues.push(...venueRows.map((r) => r.id))
    const dayRows = venueRows.map((v) => ({
      id: randomUUID(),
      slug: `venue-day-${randomUUID()}`,
      kind: "venue_day" as const,
      title: "Venue day · bound",
      description: "",
      venue_id: v.id,
      start_time: new Date(now - 3_600_000),
      end_time: new Date(now + 20 * 3_600_000),
      timezone: "Asia/Kolkata",
      status: "published" as const,
      visibility: "unlisted" as const,
      organizer_id: SYSTEM_USER_ID,
      latitude: LAT,
      longitude: LNG,
      geofence: FENCE,
    }))
    await db.events.createMany({ data: dayRows })
    const occRows = dayRows.map((d) => ({ id: randomUUID(), event_id: d.id, occurs_on: new Date(), start_time: d.start_time, end_time: d.end_time }))
    await db.event_occurrences.createMany({ data: occRows })
    await db.event_check_ins.createMany({
      data: occRows.map((o) => ({
        event_id: o.event_id,
        occurrence_id: o.id,
        user_id: runner,
        status: "checked_in" as const,
        check_in_time: older,
        expires_at: new Date(now + 3_600_000),
        created_at: older,
      })),
    })

    // A real event whose day ended two hours ago, with somebody still in it:
    // newer than every venue day's check-in, so it is last in a shared queue.
    const v = await venue()
    const eventId = await realEvent(v, { startsInMin: -6 * 60 })
    await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: { end_time: new Date(now - 2 * 3_600_000) } })
    await db.events.update({ where: { id: eventId }, data: { end_time: new Date(now - 2 * 3_600_000) } })
    const occ = await db.event_occurrences.findFirstOrThrow({ where: { event_id: eventId } })
    const stale = await person("glstale")
    await db.event_check_ins.create({
      data: { event_id: eventId, occurrence_id: occ.id, user_id: stale.id, status: "checked_in", check_in_time: new Date(now - 60 * 60_000), created_at: new Date(now - 60 * 60_000) },
    })

    await sweepPresence()
    expect((await checkInOf(eventId, stale.id)).status).toBe("checked_out")
  }, 120_000)
})

describe("stay", () => {
  const ping = (token: string, eventId: string, at = INSIDE) =>
    presenceRoute.POST(req(`/api/mobile/events/${eventId}/presence`, token, "POST", { ...at, accuracy: 10 }), eventParams(eventId))

  it("is carried on by an in-fence ping, and stops at its cap (PL-I07)", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v, { stay: true })
    const dayId = json.data.venueDayId
    expect(json.data.stay).toBe(true)
    const stayUntil = new Date(json.data.stayUntil).getTime()
    expect(stayUntil - Date.now()).toBeGreaterThan(3.9 * 3_600_000)

    // As if 55 minutes had passed: five minutes left, a ping inside moves it on.
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: me.id }, data: { expires_at: new Date(Date.now() + 5 * 60_000) } })
    const res = await ping(me.token, dayId)
    const body = (await res.json()).data
    const moved = new Date(body.expiresAt).getTime()
    expect(moved - Date.now()).toBeGreaterThan(15 * 60_000)
    expect((await checkInOf(dayId, me.id)).expires_at?.getTime()).toBe(moved)
    const member = await db.chat_group_members.findFirstOrThrow({ where: { user_id: me.id, chat_group: { event_id: dayId } } })
    expect(member.last_allowed_at?.getTime()).toBe(moved)

    // Near the cap: it stops there.
    const cap = new Date(Date.now() + 8 * 60_000)
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: me.id }, data: { stay_until: cap } })
    await ping(me.token, dayId)
    expect((await checkInOf(dayId, me.id)).expires_at?.getTime()).toBe(moved)
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: me.id }, data: { expires_at: new Date(Date.now() + 60_000) } })
    await ping(me.token, dayId)
    expect((await checkInOf(dayId, me.id)).expires_at?.getTime()).toBe(cap.getTime())
  })

  it("is not given to a fixed window, and a ping past the end checks you out", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v, { minutes: 20 })
    const dayId = json.data.venueDayId
    await ping(me.token, dayId)
    expect((await checkInOf(dayId, me.id)).expires_at?.toISOString()).toBe(json.data.expiresAt)

    await rewind(dayId, me.id, 25)
    const res = await ping(me.token, dayId)
    expect((await res.json()).data).toMatchObject({ status: "checked_out", reason: "expired" })
    expect((await sessionOf(dayId, me.id)).departed_source).toBe("expired")
  })
})

describe("GET /venues/:id (PL-I18, D-19)", () => {
  const detail = async (token: string, venueId: string) => {
    const res = await venueRoute.GET(req(`/api/mobile/venues/${venueId}`, token), { params: Promise.resolve({ venueId }) })
    return { status: res.status, text: await res.text() }
  }

  it("counts in buckets, says whether you are live, and never carries the area", async () => {
    const v = await venue()
    const viewer = await person()
    const first = await detail(viewer.token, v)
    expect(first.status).toBe(200)
    let data = JSON.parse(first.text).data
    expect(data.live).toMatchObject({ open: true, closedReason: null, liveNow: "none", youAreLive: false, expiresAt: null })

    const three = [await person(), await person(), await person()]
    for (const p of three) await goLive(p.token, v)
    data = JSON.parse((await detail(viewer.token, v)).text).data
    expect(data.live.liveNow).toBe("a_few")

    const mine = await goLive(viewer.token, v, { minutes: 45 })
    const { text } = await detail(viewer.token, v)
    data = JSON.parse(text).data
    expect(data.live).toMatchObject({
      youAreLive: true,
      expiresAt: mine.json.data.expiresAt,
      venueDayId: mine.json.data.venueDayId,
      chatGroupId: mine.json.data.chatGroupId,
      liveNow: "a_few",
    })
    expect(text).not.toMatch(/geofence|radius|"ring"/)
  })

  it("says why going live is closed", async () => {
    const unfenced = await venue({ fence: null })
    const me = await person()
    expect(JSON.parse((await detail(me.token, unfenced)).text).data.live).toMatchObject({ open: false, closedReason: "no_check_in_area" })

    const busy = await venue()
    const eventId = await realEvent(busy, { startsInMin: 30 })
    const data = JSON.parse((await detail(me.token, busy)).text).data
    expect(data.live).toMatchObject({ open: false, closedReason: "event_live_here", eventId })
    expect(data.tonight?.id).toBe(eventId)
  })

  it("refuses somebody who has not finished onboarding, and 404s an archived venue", async () => {
    const v = await venue()
    const id = await makeUser(testId("gl_nob"))
    users.push(id)
    expect((await detail(signAccessToken(id, `${id}@itest.invalid`), v)).status).toBe(403)
    await db.venues.update({ where: { id: v }, data: { status: "archived" } })
    const me = await person()
    expect((await detail(me.token, v)).status).toBe(404)
  })
})

describe("/me/attendance labels a venue day as a place (D-6)", () => {
  it("carries kind", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v)
    const res = await attendanceRoute.GET(req("/api/mobile/me/attendance", me.token))
    const events = (await res.json()).data.events as Array<{ id: string; kind: string }>
    expect(events.find((e) => e.id === json.data.venueDayId)?.kind).toBe("venue_day")
  })
})
