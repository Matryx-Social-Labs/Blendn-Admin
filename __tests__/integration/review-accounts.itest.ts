import { NextRequest } from "next/server"

/*
 * App Review accounts (lib/review-accounts.ts), OFF unless REVIEW_ACCOUNT_EMAILS
 * names somebody. For a listed account only: the geofence is skipped at an
 * event marked `review_demo` (at the door and in the presence ping that keeps
 * them in), and Blendn+ reads as gated. Everybody else, every event not marked,
 * and everybody with the list empty: unchanged. The sandbox purchase half is in
 * revenuecat-webhook.itest.ts. Real routes, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { lockedNights, plusGatedForPerson, plusRequired } from "@/lib/plus"
import { resetReviewBypassAudit } from "@/lib/review-accounts"
import { closeDb, db, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const presenceRoute = require("@/app/api/mobile/events/[eventId]/presence/route") as typeof import("@/app/api/mobile/events/[eventId]/presence/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const saved = { ...process.env }

/** The venue in Bengaluru; the reviewer in Cupertino. */
const VENUE = { lat: 12.9784, lng: 77.6408 }
const CUPERTINO = { lat: 37.3349, lng: -122.009 }

afterEach(() => {
  process.env = { ...saved }
  resetReviewBypassAudit()
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: users } } })
  await db.presence_sessions.deleteMany({ where: { user_id: { in: users } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function liveEvent(reviewDemo: boolean) {
  const owner = await makeUser(testId("rv_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("rv"),
      title: "Review fixture",
      description: "integration fixture",
      start_time: new Date(now - 30 * 60_000),
      end_time: new Date(now + 2 * 60 * 60_000),
      timezone: "Asia/Kolkata",
      city: "Bengaluru",
      status: "published",
      visibility: "public",
      organizer_id: owner,
      latitude: VENUE.lat,
      longitude: VENUE.lng,
      geofence: { type: "circle", lat: VENUE.lat, lng: VENUE.lng, radius: 60, buffer: 20 },
      review_demo: reviewDemo,
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  return event.id
}

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, email: `${id}@itest.invalid`, token: signAccessToken(id, `${id}@itest.invalid`) }
}

const post = (route: typeof checkinRoute, path: "checkin" | "presence", eventId: string, token: string, body: Record<string, unknown>) =>
  route.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ eventId }) }
  )
const checkIn = (eventId: string, token: string) =>
  post(checkinRoute, "checkin", eventId, token, { latitude: CUPERTINO.lat, longitude: CUPERTINO.lng, deviceInfo: { gpsAccuracy: 10 } })
const ping = (eventId: string, token: string) =>
  post(presenceRoute as unknown as typeof checkinRoute, "presence", eventId, token, { latitude: CUPERTINO.lat, longitude: CUPERTINO.lng, accuracy: 10 })

async function bypassAudits(userId: string) {
  for (let i = 0; i < 40; i++) {
    const rows = await db.audit_logs.findMany({ where: { resource_id: userId, action: "review.bypass" } })
    if (rows.length) return rows.map((r) => r.details as Record<string, unknown>)
    await new Promise((r) => setTimeout(r, 50))
  }
  return []
}

describe("check-in geofence", () => {
  it("lets a listed review account in from anywhere at a review_demo event, keeps it in on the ping, and audits it", async () => {
    const reviewer = await person("rv-in")
    process.env.REVIEW_ACCOUNT_EMAILS = `someone@else.test, ${reviewer.email.toUpperCase()}`
    const eventId = await liveEvent(true)

    expect((await checkIn(eventId, reviewer.token)).status).toBe(200)
    const pinged = await ping(eventId, reviewer.token)
    expect((await pinged.json()).data).toMatchObject({ status: "inside" })
    expect(await db.event_check_ins.count({ where: { event_id: eventId, user_id: reviewer.id, status: "checked_in" } })).toBe(1)

    const audits = await bypassAudits(reviewer.id)
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ bypass: "geofence", eventId, at: "checkin" })]))
  })

  it("holds everybody else to the fence: another account, an unmarked event, and the list empty", async () => {
    const reviewer = await person("rv-out")
    const other = await person("rv-other")
    const marked = await liveEvent(true)
    const unmarked = await liveEvent(false)

    process.env.REVIEW_ACCOUNT_EMAILS = reviewer.email
    expect((await checkIn(marked, other.token)).status).toBe(400)
    expect((await checkIn(unmarked, reviewer.token)).status).toBe(400)

    delete process.env.REVIEW_ACCOUNT_EMAILS
    const refused = await checkIn(marked, reviewer.token)
    expect(refused.status).toBe(400)
    expect((await refused.json()).errorCode).toBe("OUT_OF_RANGE")
    expect(await db.event_check_ins.count({ where: { user_id: { in: [reviewer.id, other.id] } } })).toBe(0)
    expect(await bypassAudits(other.id)).toEqual([])
  })
})

describe("Blendn+ gating", () => {
  it("reads as gated for a listed review account with PLUS_GATING unset, with no trial", async () => {
    delete process.env.PLUS_GATING
    const reviewer = await person("rv-plus")
    const other = await person("rv-plus-other")

    expect(await plusGatedForPerson(reviewer.id)).toBe(false)
    expect(await plusRequired(reviewer.id, "Bengaluru")).toBe(false)

    process.env.REVIEW_ACCOUNT_EMAILS = reviewer.email
    expect(await plusGatedForPerson(reviewer.id)).toBe(true)
    expect(await plusRequired(reviewer.id, "Bengaluru")).toBe(true)
    expect(await plusRequired(reviewer.id, null)).toBe(true)
    expect(await lockedNights(reviewer.id)).toBe(0)
    expect(await bypassAudits(reviewer.id)).toEqual([expect.objectContaining({ bypass: "plus_gating" })])

    // Nobody else: still launch season.
    expect(await plusGatedForPerson(other.id)).toBe(false)
    expect(await plusRequired(other.id, "Bengaluru")).toBe(false)
  })

  it("leaves a deleted review account alone", async () => {
    const reviewer = await person("rv-deleted")
    await db.user.update({ where: { id: reviewer.id }, data: { deletedAt: new Date() } })
    process.env.REVIEW_ACCOUNT_EMAILS = reviewer.email
    expect(await plusGatedForPerson(reviewer.id)).toBe(false)
  })
})
