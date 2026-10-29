import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/push-notifications", () => ({ sendPushNotification: jest.fn(async () => true) }))

import { sendPushNotification } from "@/lib/push-notifications"
import { signAccessToken } from "@/lib/mobile-auth"

import { cleanup, closeDb, db, makeEvent, makeUser, onboard } from "./helpers"

/**
 * SCRUM-892: a cancelled night takes no new RSVP. The route said 200 "going"
 * and wrote the row, so the person's "Next up" card showed a night that was
 * called off. Leaving (`not_going`, DELETE) is never refused: whoever got in
 * before the cancellation must be able to get out.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

async function setup(status: "published" | "cancelled") {
  const host = await makeUser("rc-host", "organizer")
  const guest = await makeUser("rc-guest")
  users.push(host, guest)
  await onboard(guest)
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { status } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: guest }, select: { email: true } })
  return { eventId, guest, token: signAccessToken(guest, email) }
}

const post = (eventId: string, token: string, body: unknown) =>
  route.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/rsvp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ eventId }) }
  )

const del = (eventId: string, token: string) =>
  route.DELETE(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/rsvp`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ eventId }) }
  )

const rowsFor = (eventId: string, userId: string) => db.event_rsvps.count({ where: { event_id: eventId, user_id: userId } })

describe("POST /events/:id/rsvp on a cancelled event", () => {
  it.each(["going", "maybe"] as const)("refuses %s with a sentence and a reasonCode, and writes nothing", async (status) => {
    const { eventId, guest, token } = await setup("cancelled")

    const res = await post(eventId, token, { status })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ success: false, errorCode: "CONFLICT", reasonCode: "EVENT_CANCELLED" })
    expect(body.error).toMatch(/cancelled/i)
    expect(await rowsFor(eventId, guest)).toBe(0)
  })

  it("refuses an RSVP with no status (which means going) the same way", async () => {
    const { eventId, guest, token } = await setup("cancelled")
    expect((await post(eventId, token, {})).status).toBe(409)
    expect(await rowsFor(eventId, guest)).toBe(0)
  })

  it("lets somebody who said going before the cancellation say not_going, and withdraw", async () => {
    const { eventId, guest, token } = await setup("published")
    expect((await post(eventId, token, { status: "going" })).status).toBe(200)
    await db.events.update({ where: { id: eventId }, data: { status: "cancelled" } })

    expect((await post(eventId, token, { status: "not_going" })).status).toBe(200)
    expect((await db.event_rsvps.findFirstOrThrow({ where: { event_id: eventId, user_id: guest } })).status).toBe("not_going")
    expect((await del(eventId, token)).status).toBe(200)
    expect(await rowsFor(eventId, guest)).toBe(0)
  })

  it("still takes a going RSVP on a published event", async () => {
    const { eventId, guest, token } = await setup("published")
    const res = await post(eventId, token, { status: "going" })
    expect(res.status).toBe(200)
    expect((await res.json()).data.rsvpStatus).toBe("going")
    expect(await rowsFor(eventId, guest)).toBe(1)
  })

  it("does not promote the waitlist, or push \"a place opened up\", when somebody leaves a night that was called off", async () => {
    const { eventId, guest, token } = await setup("published")
    const waiting = await makeUser("rc-wait")
    users.push(waiting)
    await db.events.update({ where: { id: eventId }, data: { max_capacity: 1 } })
    await db.event_rsvps.createMany({
      data: [
        { event_id: eventId, user_id: guest, status: "going" },
        { event_id: eventId, user_id: waiting, status: "waitlisted" },
      ],
    })
    await db.events.update({ where: { id: eventId }, data: { status: "cancelled" } })
    ;(sendPushNotification as jest.Mock).mockClear()

    expect((await post(eventId, token, { status: "not_going" })).status).toBe(200)

    expect((await db.event_rsvps.findFirstOrThrow({ where: { event_id: eventId, user_id: waiting } })).status).toBe("waitlisted")
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it("a waitlisted person who asks for going on a cancelled event is refused and keeps their row as it was", async () => {
    const { eventId, guest, token } = await setup("published")
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: guest, status: "waitlisted" } })
    await db.events.update({ where: { id: eventId }, data: { status: "cancelled" } })

    expect((await post(eventId, token, { status: "going" })).status).toBe(409)
    expect((await db.event_rsvps.findFirstOrThrow({ where: { event_id: eventId, user_id: guest } })).status).toBe("waitlisted")
  })
})
