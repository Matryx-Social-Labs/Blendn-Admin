import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is pure ESM; nothing here signs in with Google (checkin.itest.ts).
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { getEventOverview } from "@/lib/event-overview"
import { signAccessToken } from "@/lib/mobile-auth"
import { forgetCheckInPoints } from "@/lib/presence-sweeper"

import { closeDb, db, makeUser, onboard, testId } from "./helpers"

/**
 * Where somebody stood at a check-in, and what phone they held, is kept three
 * days after the night and then forgotten, for every check-in, door or Go Live
 * (D-029, SCRUM-1230). The row stays: it is the attendance record, kept a year.
 * Go Live's own case is go-live-sweeper.itest.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as
  typeof import("@/app/api/mobile/events/[eventId]/checkin/route")

const DAY = 86_400_000
const LAT = 12.9784
const LNG = 77.6408
const PHONE = { platform: "ios", gpsAccuracy: 8, device: "iPhone 17 Pro", appVersion: "1.4.0", carrier: "x" }

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

/** An event whose one occurrence ended `endedDaysAgo` days ago (negative: still on). */
async function night(endedDaysAgo: number) {
  const owner = await makeUser("cp_own", "organizer")
  users.push(owner)
  const end = new Date(Date.now() - endedDaysAgo * DAY)
  const start = new Date(end.getTime() - 3 * 3_600_000)
  const event = await db.events.create({
    data: {
      slug: testId("cp"),
      title: "Check-in point fixture",
      description: "integration fixture",
      start_time: start,
      end_time: end,
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
  const occurrence = await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  return { eventId: event.id, occurrenceId: occurrence.id, start }
}

/** One door check-in at `n`, with its presence session, both holding the point. */
async function doorRow(
  n: { eventId: string; occurrenceId: string; start: Date },
  opts: { outDaysAgo?: number; deviceInfo?: object | null } = {}
) {
  const user = await makeUser("cp")
  users.push(user)
  const out = opts.outDaysAgo === undefined ? null : new Date(Date.now() - opts.outDaysAgo * DAY)
  const row = await db.event_check_ins.create({
    data: {
      event_id: n.eventId,
      occurrence_id: n.occurrenceId,
      user_id: user,
      status: out ? "checked_out" : "checked_in",
      check_in_time: n.start,
      check_out_time: out,
      latitude: LAT,
      longitude: LNG,
      ...(opts.deviceInfo !== null && { device_info: opts.deviceInfo ?? PHONE }),
    },
  })
  await db.presence_sessions.create({
    data: {
      event_id: n.eventId,
      occurrence_id: n.occurrenceId,
      user_id: user,
      arrived_at: n.start,
      departed_at: out,
      last_lat: LAT,
      last_lng: LNG,
      last_accuracy: 8,
    },
  })
  return { id: row.id, user, occurrenceId: n.occurrenceId }
}

const rowOf = (id: string) =>
  db.event_check_ins.findUniqueOrThrow({
    where: { id },
    select: { latitude: true, longitude: true, device_info: true, status: true, check_in_time: true },
  })
const sessionOf = (r: { user: string; occurrenceId: string }) =>
  db.presence_sessions.findFirstOrThrow({
    where: { user_id: r.user, occurrence_id: r.occurrenceId },
    select: { last_lat: true, last_lng: true, last_accuracy: true },
  })

/** Passes until nothing is left, as the five-minute loop would. */
async function drain() {
  while ((await forgetCheckInPoints()) > 0);
}

describe("a door check-in forgets where it was three days after the night", () => {
  it("nulls the point of a check-out four days ago and keeps the row; leaves yesterday's alone", async () => {
    const n = await night(5)
    const old = await doorRow(n, { outDaysAgo: 4 })
    const recent = await doorRow(await night(1.5), { outDaysAgo: 1 })

    await drain()

    expect(await rowOf(old.id)).toEqual({
      latitude: null,
      longitude: null,
      device_info: { platform: "ios", gpsAccuracy: 8 },
      status: "checked_out",
      check_in_time: n.start,
    })
    expect(await sessionOf(old)).toEqual({ last_lat: null, last_lng: null, last_accuracy: null })

    expect(await rowOf(recent.id)).toMatchObject({ latitude: LAT, longitude: LNG, device_info: PHONE })
    // A session's point has no reader at any age, so the ones written before go now.
    expect(await sessionOf(recent)).toEqual({ last_lat: null, last_lng: null, last_accuracy: null })
  })

  it("counts from the occurrence's end for a row never checked out", async () => {
    const stale = await doorRow(await night(4))
    const tonight = await doorRow(await night(-0.05))

    await drain()

    expect(await rowOf(stale.id)).toMatchObject({ latitude: null, longitude: null })
    expect(await rowOf(tonight.id)).toMatchObject({ latitude: LAT, longitude: LNG })
  })

  it("reaches a backlog older than a month (the old window stopped at 30 days)", async () => {
    const ancient = await doorRow(await night(90), { outDaysAgo: 89 })
    await drain()
    expect(await rowOf(ancient.id)).toMatchObject({ latitude: null, longitude: null })
  })

  it("drains in bounded batches across passes", async () => {
    const n = await night(6)
    const rows = [await doorRow(n, { outDaysAgo: 5 }), await doorRow(n, { outDaysAgo: 5 }), await doorRow(n, { outDaysAgo: 5 })]

    // Other suites' rows share this database, so: never more than the batch, and not all three in one pass.
    const pointsLeft = async () => (await Promise.all(rows.map((r) => rowOf(r.id)))).filter((r) => r.latitude !== null).length
    await forgetCheckInPoints(new Date(), 2)
    expect(await pointsLeft()).toBeGreaterThanOrEqual(1)
    while ((await forgetCheckInPoints(new Date(), 2)) > 0);
    expect(await pointsLeft()).toBe(0)
  })
})

describe("device_info keeps exactly the allowed keys it had", () => {
  it.each([
    ["the app's fields and an unknown key", PHONE, { platform: "ios", gpsAccuracy: 8 }],
    ["seed markers", { platform: "android", source: "seed-blr-scenarios", device: "Pixel" }, { platform: "android", source: "seed-blr-scenarios" }],
    ["a scale-seed tag alone", { qaScale: true }, { qaScale: true }],
    ["no allowed key at all", { device: "Pixel", appVersion: "1.4.0" }, null],
    ["a value that is not an object", ["ios"], null],
    ["nothing", null, null],
  ])("%s", async (_label, deviceInfo, kept) => {
    const r = await doorRow(await night(5), { outDaysAgo: 4, deviceInfo })
    await drain()
    expect((await rowOf(r.id)).device_info).toEqual(kept)
  })
})

describe("the dashboard's attended count does not move", () => {
  it("reads the same overview before and after the pass", async () => {
    const n = await night(5)
    await doorRow(n, { outDaysAgo: 4 })
    await doorRow(n, { outDaysAgo: 4 })
    const before = await getEventOverview(n.eventId)
    expect(before?.tiles.find((t) => t.label === "Checked in")?.value).toBe("2")

    await drain()

    expect(await getEventOverview(n.eventId)).toEqual(before)
  })
})

describe("a presence session stores no point (nothing reads one)", () => {
  it("opens the door's session without the coordinates the door was given", async () => {
    const { eventId, occurrenceId } = await night(-2 / 24)
    const id = await makeUser("cp_door")
    users.push(id)
    await onboard(id)
    const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
    const res = await checkinRoute.POST(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkin`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(id, email)}` },
        body: JSON.stringify({ latitude: LAT, longitude: LNG, deviceInfo: { platform: "ios", gpsAccuracy: 8 } }),
      }),
      { params: Promise.resolve({ eventId }) }
    )
    expect(res.status).toBe(200)

    // The session is written beside the check-in, not awaited (openSeatSession).
    let session = null
    for (let i = 0; i < 50 && !session; i++) {
      session = await db.presence_sessions.findFirst({ where: { user_id: id, occurrence_id: occurrenceId } })
      if (!session) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(session).toMatchObject({ last_lat: null, last_lng: null, last_accuracy: null })
  })
})
