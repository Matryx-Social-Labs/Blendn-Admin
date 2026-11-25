import { NextRequest } from "next/server"

/*
 * SCRUM-1326 (serving/07c): a weak fix, or one lone outside reading, never
 * checks anybody out. Real routes (the door, the ping) and the real sweeper,
 * against real rows. Unit rules: __tests__/presence.test.ts.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { sweepPresence } from "@/lib/presence-sweeper"
import { DEPARTURE_ALLOWANCE_MINUTES, DEPARTURE_GRACE_MINUTES } from "@/lib/presence"
import { MAX_GPS_ACCURACY_METERS } from "@/lib/geofence"
import { closeDb, db, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const presenceRoute = require("@/app/api/mobile/events/[eventId]/presence/route") as typeof import("@/app/api/mobile/events/[eventId]/presence/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []

const VENUE = { lat: 12.9784, lng: 77.6408 }
/** ~500 m north: outside anything the allowance can excuse. */
const OUTSIDE = { lat: 12.9829, lng: 77.6408 }
const WEAK = 400 // a Balanced fix indoors
const GOOD = 20

afterAll(async () => {
  await db.presence_sessions.deleteMany({ where: { user_id: { in: users } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.event_match_preferences.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

const minutes = (n: number) => n * 60_000
const later = (mins: number) => new Date(Date.now() + minutes(mins))

async function liveEvent() {
  const owner = await makeUser(testId("wf_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("wf"),
      title: "Weak fix fixture",
      description: "integration fixture",
      start_time: new Date(now - minutes(30)),
      end_time: new Date(now + minutes(5 * 60)),
      timezone: "Asia/Kolkata",
      city: "Bengaluru",
      status: "published",
      visibility: "public",
      organizer_id: owner,
      latitude: VENUE.lat,
      longitude: VENUE.lng,
      geofence: { type: "circle", lat: VENUE.lat, lng: VENUE.lng, radius: 60, buffer: 20 },
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  return event.id
}

const post = (route: typeof checkinRoute, path: string, eventId: string, token: string, body: Record<string, unknown>) =>
  route.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ eventId }) }
  )

/** Checked in at the door, at the centre, with a good fix. */
async function guest(label: string) {
  const eventId = await liveEvent()
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  const token = signAccessToken(id, `${id}@itest.invalid`)
  const res = await post(checkinRoute, "checkin", eventId, token, { latitude: VENUE.lat, longitude: VENUE.lng, deviceInfo: { gpsAccuracy: GOOD } })
  expect(res.status).toBe(200)
  const ping = async (at: { lat: number; lng: number }, accuracy: number) => {
    const r = await post(presenceRoute as unknown as typeof checkinRoute, "presence", eventId, token, { latitude: at.lat, longitude: at.lng, accuracy })
    return (await r.json()).data as { status: string; reason?: string }
  }
  const row = () =>
    db.event_check_ins.findFirstOrThrow({
      where: { event_id: eventId, user_id: id },
      select: { id: true, status: true, left_area_at: true, last_seen_at: true },
    })
  /** Move the stored readings back, as if they had been taken `mins` ago. */
  const shift = async (fields: { left_area_at?: number; last_seen_at?: number }) => {
    const { id: rowId } = await row()
    await db.event_check_ins.update({
      where: { id: rowId },
      data: Object.fromEntries(Object.entries(fields).map(([k, m]) => [k, new Date(Date.now() - minutes(m))])),
    })
  }
  return { eventId, token, ping, row, shift }
}

describe("a weak fix (worse than the door accepts) never starts or advances the outside clock", () => {
  it("leaves left_area_at alone, does not move the check-in's last_seen_at, and answers unknown", async () => {
    const g = await guest("wf-weak")
    const before = await g.row()
    const res = await g.ping(OUTSIDE, WEAK)
    expect(res.status).toBe("unknown")
    const after = await g.row()
    expect(after.left_area_at).toBeNull()
    expect(after.last_seen_at).toEqual(before.last_seen_at)
  })

  it("does not stand in for the second outside reading after a lone good one", async () => {
    const g = await guest("wf-weak-second")
    expect((await g.ping(OUTSIDE, GOOD)).status).toBe("outside")
    await g.shift({ left_area_at: DEPARTURE_ALLOWANCE_MINUTES + 5, last_seen_at: DEPARTURE_ALLOWANCE_MINUTES + 5 })
    const shifted = await g.row()
    // Pocketed indoors: blurry fixes only from here on. Past the write throttle, so the route writes this one.
    expect((await g.ping(OUTSIDE, WEAK)).status).toBe("unknown")
    // The check-in's last_seen_at must not move (it would pass for the second outside reading)...
    expect((await g.row()).last_seen_at).toEqual(shifted.last_seen_at)
    // ...while the session's heartbeat does: the phone is alive.
    const session = await db.presence_sessions.findFirstOrThrow({ where: { event_id: g.eventId, departed_at: null }, select: { last_seen_at: true } })
    expect(Date.now() - session.last_seen_at!.getTime()).toBeLessThan(60_000)
    await sweepPresence(later(1))
    expect((await g.row()).status).toBe("checked_in")
  })
})

describe("one outside reading alone never checks anyone out", () => {
  it("survives 25 minutes of silence after a single good outside reading", async () => {
    const g = await guest("wf-lone")
    expect((await g.ping(OUTSIDE, GOOD)).status).toBe("outside")
    expect((await g.row()).left_area_at).not.toBeNull()
    await sweepPresence(later(DEPARTURE_ALLOWANCE_MINUTES + 5))
    expect((await g.row()).status).toBe("checked_in")
  })

  it("an inside reading clears the clock", async () => {
    const g = await guest("wf-back")
    await g.ping(OUTSIDE, GOOD)
    expect((await g.ping(VENUE, GOOD)).status).toBe("inside")
    expect((await g.row()).left_area_at).toBeNull()
  })
})

describe("a guest who really left is still checked out", () => {
  it("by the sweeper, after two good outside readings a grace period apart and 20 minutes", async () => {
    const g = await guest("wf-gone-sweep")
    await g.ping(OUTSIDE, GOOD)
    // First reading 25 min ago, second 13 min ago (the 5-minute write throttle stores it).
    await g.shift({ left_area_at: 25, last_seen_at: 25 - DEPARTURE_GRACE_MINUTES - 2 })
    await sweepPresence()
    const r = await g.row()
    expect(r.status).toBe("checked_out")
  })

  it("by the ping itself, when the second good outside reading comes 20+ minutes after the first", async () => {
    const g = await guest("wf-gone-ping")
    await g.ping(OUTSIDE, GOOD)
    await g.shift({ left_area_at: DEPARTURE_ALLOWANCE_MINUTES + 1, last_seen_at: DEPARTURE_ALLOWANCE_MINUTES + 1 })
    expect((await g.ping(OUTSIDE, GOOD)).status).toBe("checked_out")
  })
})

describe("the door is unchanged", () => {
  it("still refuses a fix worse than its limit", async () => {
    const eventId = await liveEvent()
    const id = await makeUser(testId("wf-door"))
    users.push(id)
    await onboard(id)
    const token = signAccessToken(id, `${id}@itest.invalid`)
    const res = await post(checkinRoute, "checkin", eventId, token, {
      latitude: VENUE.lat,
      longitude: VENUE.lng,
      deviceInfo: { gpsAccuracy: MAX_GPS_ACCURACY_METERS + 1 },
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toMatch(/GPS signal is too weak/)
  })
})
