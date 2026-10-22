import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/**
 * Which places am I inside (SCRUM-704): judged against the real fences, in the
 * order the pass docks, and only where the door would let you in — so the
 * disc never lights at a door that refuses you, nor stays dark at one that
 * would not.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const insideRoute = require("@/app/api/mobile/checkins/inside/route") as typeof import("@/app/api/mobile/checkins/inside/route")
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const liveRoute = require("@/app/api/mobile/venues/[venueId]/live/route") as typeof import("@/app/api/mobile/venues/[venueId]/live/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const venues: string[] = []

afterAll(async () => {
  const days = await db.events.findMany({ where: { venue_id: { in: venues } }, select: { id: true } })
  const all = [...events, ...days.map((d) => d.id)]
  await db.presence_sessions.deleteMany({ where: { event_id: { in: all } } })
  await db.event_favorites.deleteMany({ where: { event_id: { in: all } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: all } } })
  await cleanup(users, all)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await closeDb()
})

/** A point of this test's own, far from every other suite's fixtures. */
const spot = () => ({ lat: 51.5 + Math.random() * 0.5, lng: -0.1 - Math.random() * 0.5 })
type Spot = ReturnType<typeof spot>
const fence = (p: Spot) => ({ type: "circle", lat: p.lat, lng: p.lng, radius: 60, buffer: 20 })

async function person(age: number | null = 30) {
  const id = await makeUser(testId("pi"))
  users.push(id)
  await onboard(id)
  if (age !== null) await db.profiles.update({ where: { id }, data: { date_of_birth: new Date(Date.now() - (age * 365.25 + 30) * 86_400_000) } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function event(
  p: Spot,
  title: string,
  opts: { startMin?: number; visibility?: "public" | "private"; minAge?: number; venueId?: string; cancelled?: boolean } = {}
) {
  const host = await makeUser(testId("pi_host"), "organizer")
  users.push(host)
  const start = new Date(Date.now() + (opts.startMin ?? -30) * 60_000)
  const end = new Date(Date.now() + 3 * 3_600_000)
  const e = await db.events.create({
    data: {
      slug: testId("pi"),
      title,
      description: "integration fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "published",
      visibility: opts.visibility ?? "public",
      organizer_id: host,
      min_age: opts.minAge ?? null,
      venue_id: opts.venueId ?? null,
      latitude: p.lat,
      longitude: p.lng,
      geofence: fence(p),
    },
  })
  events.push(e.id)
  await db.event_occurrences.create({
    data: {
      event_id: e.id,
      occurs_on: new Date(start.toISOString().slice(0, 10)),
      start_time: start,
      end_time: end,
      ...(opts.cancelled && { cancelled_at: new Date() }),
    },
  })
  return e.id
}

async function venue(p: Spot, opts: { area?: boolean } = {}) {
  const v = await db.venues.create({
    data: {
      name: testId("Toit"),
      city: "Bengaluru",
      latitude: p.lat,
      longitude: p.lng,
      ...(opts.area !== false && { geofence: fence(p) }),
      timezone: "UTC",
      day_reset_hour: (new Date().getUTCHours() + 12) % 24,
    },
  })
  venues.push(v.id)
  return v.id
}

const post = (url: string, token: string, body: object) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

async function inside(token: string, p: Spot, gpsAccuracy?: number) {
  const res = await insideRoute.POST(
    post("/api/mobile/checkins/inside", token, { latitude: p.lat, longitude: p.lng, ...(gpsAccuracy !== undefined && { deviceInfo: { gpsAccuracy } }) })
  )
  return { status: res.status, json: await res.json() }
}

type Place = { kind: string; eventId: string | null; venueId: string | null; name: string; going: boolean; saved: boolean; checkedIn: boolean }
const ids = (places: Place[]) => places.map((p) => p.eventId ?? p.venueId)

describe("POST /checkins/inside", () => {
  it("lists every place whose fence you are inside, in the order the pass docks", async () => {
    const p = spot()
    const me = await person()
    const longest = await event(p, "On since nine", { startMin: -60 })
    const going = await event(p, "Going to this", { startMin: -10 })
    const saved = await event(p, "Saved this", { startMin: -30 })
    const bar = await venue(p)
    await db.event_rsvps.create({ data: { event_id: going, user_id: me.id, status: "going" } })
    await db.event_favorites.create({ data: { event_id: saved, user_id: me.id } })

    const { status, json } = await inside(me.token, p)

    expect(status).toBe(200)
    // 1 going or saved (soonest started first among them), 2 events before a venue, 3 soonest started.
    expect(ids(json.data.places)).toEqual([saved, going, longest, bar])
    expect(json.data.total).toBe(4)
    expect(json.data.places[0]).toMatchObject({ kind: "event", saved: true, going: false, checkedIn: false })
    expect(json.data.places[1]).toMatchObject({ going: true })
    expect(json.data.places[3]).toMatchObject({ kind: "venue", eventId: null, venueId: bar, startTime: null })
    expect(json.data.current).toBeNull()
  })

  it("says where you are now, so the pass can warn before the hold", async () => {
    const p = spot()
    const me = await person()
    const here = await event(p, "Fandom")
    const other = await event(p, "Neon Nights", { startMin: -10 })
    const res = await checkinRoute.POST(post(`/api/mobile/events/${here}/checkin`, me.token, { latitude: p.lat, longitude: p.lng }), {
      params: Promise.resolve({ eventId: here }),
    })
    expect(res.status).toBe(200)

    const { json } = await inside(me.token, p)

    expect(json.data.current).toEqual({ eventId: here, kind: "event", venueId: null, name: "Fandom" })
    const byId = new Map((json.data.places as Place[]).map((x) => [x.eventId, x]))
    expect(byId.get(here)?.checkedIn).toBe(true)
    expect(byId.get(other)?.checkedIn).toBe(false)
  })

  it("never hands back a venue's day id, and marks the venue you are live at (M1)", async () => {
    const p = spot()
    const me = await person()
    const bar = await venue(p)
    const live = await liveRoute.POST(post(`/api/mobile/venues/${bar}/live`, me.token, { latitude: p.lat, longitude: p.lng, minutes: 20 }), {
      params: Promise.resolve({ venueId: bar }),
    })
    expect(live.status).toBe(200)
    const dayId = (await live.json()).data.venueDayId as string

    const res = await insideRoute.POST(post("/api/mobile/checkins/inside", me.token, { latitude: p.lat, longitude: p.lng }))
    const json = await res.json()
    expect(json.data.places).toEqual([expect.objectContaining({ kind: "venue", venueId: bar, eventId: null, checkedIn: true })])
    expect(json.data.current).toMatchObject({ kind: "venue_day", venueId: bar })
    // The day's id rides only on `current` (the room you are in), never on a place.
    expect(JSON.stringify(json.data.places)).not.toContain(dayId)
  })

  it("is nowhere a metre outside every fence, and nowhere on a fix the doors refuse", async () => {
    const p = spot()
    const me = await person()
    await event(p, "Just over there")
    await venue(p)

    expect((await inside(me.token, { lat: p.lat + 0.005, lng: p.lng })).json.data).toMatchObject({ places: [], total: 0 })
    // 200 m accuracy: the door answers GPS_TOO_VAGUE, so the disc must not light.
    expect((await inside(me.token, p, 200)).json.data).toMatchObject({ places: [], total: 0 })
    // A fix within the allowance still counts.
    expect((await inside(me.token, p, 40)).json.data.total).toBe(2)
  })

  it("never lists a door that would refuse you", async () => {
    const p = spot()
    const minor = await person(19)
    const stranger = await person()
    await event(p, "Private party", { visibility: "private" })
    const adultsOnly = await event(p, "21+ night", { minAge: 21, startMin: -45 })
    await event(p, "Called off tonight", { cancelled: true })
    await event(p, "Starts in four hours", { startMin: 240 })
    await venue(p, { area: false })
    const open = await event(p, "Open to all")

    // Private: not on the guest list. Cancelled day, not started: the door's own day rule.
    // A venue nobody drew an area for: NO_CHECK_IN_AREA.
    expect(ids((await inside(stranger.token, p)).json.data.places)).toEqual([adultsOnly, open])
    // Under the event's age; and a venue's room is adults only.
    expect(ids((await inside(minor.token, p)).json.data.places)).toEqual([open])
  })

  it("does not offer a venue an event has taken over, only the event", async () => {
    const p = spot()
    const me = await person()
    const bar = await venue(p)
    const night = await event(p, "Jazz at the bar", { venueId: bar })

    expect(ids((await inside(me.token, p)).json.data.places)).toEqual([night])
  })

  it("does not light for somebody the doors hold for onboarding", async () => {
    const p = spot()
    await event(p, "Anyone")
    const id = await makeUser(testId("pi_new"))
    users.push(id)
    const { json } = await inside(signAccessToken(id, `${id}@itest.invalid`), p)
    expect(json.data).toMatchObject({ places: [], total: 0, current: null })
  })

  it("refuses a request with no position", async () => {
    const me = await person()
    const res = await insideRoute.POST(post("/api/mobile/checkins/inside", me.token, {}))
    expect(res.status).toBe(400)
  })
})
