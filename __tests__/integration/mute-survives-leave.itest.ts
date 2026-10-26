import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"

/*
 * API M2 (security audit): a muted member lifted their own mute by leaving the
 * room and checking in again — the leave wrote `left`, and the rejoin only
 * kept `muted` when the row still said `muted`. The mute is `muted_at`; it
 * outlives the status.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkoutRoute = require("@/app/api/mobile/events/[eventId]/checkout/route") as typeof import("@/app/api/mobile/events/[eventId]/checkout/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const leaveRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/leave/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/leave/route")

const LAT = 12.9784
const LNG = 77.6408
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function liveEvent() {
  const owner = await makeUser(testId("ml_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("ml"), title: "Mute fixture", description: "integration fixture",
      start_time: new Date(now - 30 * 60_000), end_time: new Date(now + 2 * 60 * 60_000),
      timezone: "UTC", status: "published", visibility: "public", organizer_id: owner,
      latitude: LAT, longitude: LNG,
      geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 },
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  return event.id
}

const auth = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` })
const checkIn = (eventId: string, token: string) =>
  checkinRoute.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkin`, { method: "POST", headers: auth(token), body: JSON.stringify({ latitude: LAT, longitude: LNG }) }),
    { params: Promise.resolve({ eventId }) }
  )
const checkOut = (eventId: string, token: string) =>
  checkoutRoute.POST(new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkout`, { method: "POST", headers: auth(token) }), { params: Promise.resolve({ eventId }) })
const leave = (chatGroupId: string, token: string) =>
  leaveRoute.POST(new NextRequest(`http://localhost/api/mobile/chat/groups/${chatGroupId}/leave`, { method: "POST", headers: auth(token) }), { params: Promise.resolve({ chatGroupId }) })

describe("a mute survives leaving and checking in again", () => {
  it("restores muted, not active, after leave + re-check-in", async () => {
    const eventId = await liveEvent()
    const id = await makeUser(testId("ml_u"))
    users.push(id)
    await onboard(id)
    const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
    const token = signAccessToken(id, email)

    expect((await checkIn(eventId, token)).status).toBe(200)
    const group = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
    await db.chat_group_members.update({
      where: { chat_group_id_user_id: { chat_group_id: group.id, user_id: id } },
      data: { status: "muted", muted_at: new Date(), muted_by: users[0] },
    })

    expect((await leave(group.id, token)).status).toBe(200)
    expect((await checkOut(eventId, token)).status).toBe(200)
    expect((await checkIn(eventId, token)).status).toBe(200)

    const row = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: group.id, user_id: id } },
      select: { status: true, left_at: true },
    })
    expect(row).toEqual({ status: "muted", left_at: null })
  })
})
