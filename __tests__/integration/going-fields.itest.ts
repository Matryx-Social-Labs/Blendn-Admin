/**
 * The Going tab's server fields: what moved under you on `/me/rsvps` and
 * `/users/:id/favorites` (the event read's own values), and how long a venue
 * visit lasted and where on `/me/attendance`. Real handlers, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { NextRequest } from "next/server"
import { updateEventTracked } from "@/lib/event-change"
import { venueDayFor } from "@/lib/venue-day"
import { cleanupWorld, eventParams, person, req, routes, venue } from "./go-live-world"
import { closeDb, db, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rsvpsRoute = require("@/app/api/mobile/me/rsvps/route") as typeof import("@/app/api/mobile/me/rsvps/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const favoritesRoute = require("@/app/api/mobile/users/[userId]/favorites/route") as typeof import("@/app/api/mobile/users/[userId]/favorites/route")

const HOUR = 3_600_000
const MIN = 60_000
const events: string[] = []

afterAll(async () => {
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.event_favorites.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await cleanupWorld()
  await closeDb()
})

async function publishedEvent(label: string, owner: string, startsInH: number) {
  const start = new Date(Date.now() + startsInH * HOUR)
  const row = await db.events.create({
    data: {
      slug: testId(label),
      title: `${label} ${testId("t")}`,
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: owner,
      venue_name: "The Old Room",
      address: "1 Church St",
      city: "Bengaluru",
      latitude: 12.97,
      longitude: 77.59,
    },
  })
  events.push(row.id)
  return row
}

describe("changedAt / changedFields on the Going lists", () => {
  let me: { id: string; token: string }
  let steady = ""
  let moved = ""
  let back = ""
  let cancelled = ""

  beforeAll(async () => {
    me = await person("gf_me")
    const host = await person("gf_host")
    const [a, b, c, d] = await Promise.all([
      publishedEvent("steady", host.id, 30),
      publishedEvent("moved", host.id, 31),
      publishedEvent("back", host.id, 32),
      publishedEvent("cancelled", host.id, 33),
    ])
    ;[steady, moved, back, cancelled] = [a.id, b.id, c.id, d.id]

    await updateEventTracked({
      where: { id: moved },
      data: { start_time: new Date(b.start_time.getTime() + HOUR), end_time: new Date(b.end_time.getTime() + HOUR), venue_name: "The New Room" },
    })
    // Moved and put back: no change at all.
    await updateEventTracked({ where: { id: back }, data: { start_time: new Date(c.start_time.getTime() + HOUR) } })
    await updateEventTracked({ where: { id: back }, data: { start_time: c.start_time } })
    await updateEventTracked({ where: { id: cancelled }, data: { status: "cancelled" } })

    for (const id of [steady, moved, back, cancelled]) {
      await db.event_rsvps.create({ data: { event_id: id, user_id: me.id, status: "going" } })
      await db.event_favorites.create({ data: { event_id: id, user_id: me.id } })
    }
  })

  const detail = async (id: string) =>
    (await (await routes.event.GET(req(`/api/mobile/events/${id}`, me.token), eventParams(id))).json()).data

  const rowsOf = (events: { id: string; changedAt: string | null; changedFields: string[] }[]) =>
    Object.fromEntries(events.map((e) => [e.id, { changedAt: e.changedAt, changedFields: e.changedFields }]))

  it("/me/rsvps carries the event read's values on every row", async () => {
    const res = await rsvpsRoute.GET(req("/api/mobile/me/rsvps?limit=50", me.token))
    const rows = rowsOf((await res.json()).data.events)

    expect(rows[steady]).toEqual({ changedAt: null, changedFields: [] })
    expect(rows[back]).toEqual({ changedAt: null, changedFields: [] })
    expect(rows[moved].changedFields).toEqual(["time", "venue"])
    expect(rows[cancelled].changedFields).toEqual(["cancelled"])
    for (const id of [steady, moved, back, cancelled]) {
      const d = await detail(id)
      expect(rows[id]).toEqual({ changedAt: d.changedAt, changedFields: d.changedFields })
    }
  })

  it("/users/:id/favorites carries the same two on every row", async () => {
    const res = await favoritesRoute.GET(
      new NextRequest(`http://localhost/api/mobile/users/${me.id}/favorites?limit=50`, {
        headers: { authorization: `Bearer ${me.token}` },
      }),
      { params: Promise.resolve({ userId: me.id }) }
    )
    const rows = rowsOf((await res.json()).data.events)

    expect(rows[steady]).toEqual({ changedAt: null, changedFields: [] })
    expect(rows[moved].changedFields).toEqual(["time", "venue"])
    expect(rows[cancelled].changedFields).toEqual(["cancelled"])
    for (const id of [steady, moved, back, cancelled]) {
      const d = await detail(id)
      expect(rows[id]).toEqual({ changedAt: d.changedAt, changedFields: d.changedFields })
    }
  })

  it("leaves changedFrom off the rows and the old fields where they were", async () => {
    const body = await (await rsvpsRoute.GET(req("/api/mobile/me/rsvps?limit=1", me.token))).json()
    const row = body.data.events[0]
    expect(row).not.toHaveProperty("changedFrom")
    expect(Object.keys(row)).toEqual(
      expect.arrayContaining(["id", "title", "venueName", "startTime", "endTime", "status", "rsvpStatus", "rsvpAt"])
    )
  })
})

describe("stay_minutes and venue_id on GET /me/attendance", () => {
  let me: { id: string; token: string }
  let other: { id: string; token: string }
  let venueId = ""
  let emptyVenueId = ""
  let dayId = ""
  let emptyDayId = ""
  let realEventId = ""

  async function visit(userId: string, dayEventId: string, occurrenceId: string) {
    const at = new Date(Date.now() - 5 * HOUR)
    await db.event_check_ins.create({
      data: {
        event_id: dayEventId,
        occurrence_id: occurrenceId,
        user_id: userId,
        kind: "attendee",
        status: "checked_out",
        check_in_time: at,
        check_out_time: new Date(at.getTime() + 20 * MIN),
      },
    })
    return at
  }

  const session = (userId: string, ev: string, occ: string, from: Date, minutes: number, open = false) =>
    db.presence_sessions.create({
      data: {
        event_id: ev,
        occurrence_id: occ,
        user_id: userId,
        kind: "attendee",
        arrived_at: from,
        last_seen_at: new Date(from.getTime() + minutes * MIN),
        ...(!open && { departed_at: new Date(from.getTime() + minutes * MIN), departed_source: "user" as const }),
      },
    })

  beforeAll(async () => {
    me = await person("gf_att_me")
    other = await person("gf_att_other")
    venueId = await venue()
    emptyVenueId = await venue()
    const day = await venueDayFor(venueId)
    const emptyDay = await venueDayFor(emptyVenueId)
    if (!day || !emptyDay) throw new Error("no venue day")
    dayId = day.id
    emptyDayId = emptyDay.id

    const at = await visit(me.id, day.id, day.occurrenceId)
    // Two closed stretches (30 + 20) and one still open to its last heartbeat (10): 60.
    await session(me.id, day.id, day.occurrenceId, at, 30)
    await session(me.id, day.id, day.occurrenceId, new Date(at.getTime() + 40 * MIN), 20)
    await session(me.id, day.id, day.occurrenceId, new Date(at.getTime() + 90 * MIN), 10, true)
    // Somebody else's long stay at the same place is not mine.
    await visit(other.id, day.id, day.occurrenceId)
    await session(other.id, day.id, day.occurrenceId, at, 240)

    // A visit with no session to measure: unknown, not zero.
    await visit(me.id, emptyDay.id, emptyDay.occurrenceId)

    // A real event with a presence session: its row carries neither field.
    const host = await person("gf_att_host")
    const start = new Date(Date.now() - 48 * HOUR)
    const real = await db.events.create({
      data: {
        slug: testId("gfreal"),
        title: "Past night",
        description: "integration fixture",
        start_time: start,
        end_time: new Date(start.getTime() + 3 * HOUR),
        timezone: "UTC",
        status: "published",
        organizer_id: host.id,
        venue_id: venueId,
      },
    })
    events.push(real.id)
    realEventId = real.id
    const occ = await db.event_occurrences.create({
      data: { event_id: real.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: real.end_time },
    })
    await db.event_check_ins.create({
      data: { event_id: real.id, occurrence_id: occ.id, user_id: me.id, kind: "attendee", status: "checked_out", check_in_time: start },
    })
    await session(me.id, real.id, occ.id, start, 45)
  })

  afterAll(async () => {
    await db.presence_sessions.deleteMany({ where: { event_id: { in: [realEventId, dayId, emptyDayId] } } })
    await db.event_occurrences.deleteMany({ where: { event_id: realEventId } })
  })

  const mine = async (user: { token: string }) =>
    (await (await routes.attendance.GET(req("/api/mobile/me/attendance?limit=50", user.token))).json()).data.events as {
      id: string
      kind: string
      stay_minutes: number | null
      venue_id: string | null
    }[]

  it("a venue visit says how long (sessions summed, rounded) and which place", async () => {
    const row = (await mine(me)).find((e) => e.id === dayId)
    expect(row).toMatchObject({ kind: "venue_day", stay_minutes: 60, venue_id: venueId })
  })

  it("a visit with no presence session is null, not zero, and still names its venue", async () => {
    const row = (await mine(me)).find((e) => e.id === emptyDayId)
    expect(row).toMatchObject({ kind: "venue_day", stay_minutes: null, venue_id: emptyVenueId })
  })

  it("an event's row says null for both, whatever its sessions", async () => {
    const row = (await mine(me)).find((e) => e.id === realEventId)
    expect(row).toMatchObject({ kind: "event", stay_minutes: null, venue_id: null })
  })

  it("is the caller's own: another person's stay at the same place is theirs", async () => {
    const theirs = (await mine(other)).find((e) => e.id === dayId)
    expect(theirs?.stay_minutes).toBe(240)
    expect((await mine(me)).find((e) => e.id === dayId)?.stay_minutes).toBe(60)
  })
})
