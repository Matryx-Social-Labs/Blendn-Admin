import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { admitAtDoor } from "@/lib/ticket-door"

import { closeDb, db, makeUser, testId } from "./helpers"
import { buyer, capturedDelivery, deliver, fakeRazorpay, heldOrder, newWorld, settled, teardown, ticketEnv, ticketedEvent, type FakeRazorpay } from "./ticket-world"

/**
 * The hole #907 left open (SCRUM-1014): on a native ticketed event, the
 * mobile check-in let anyone at the venue in, ticket or not. It now needs a
 * valid ticket (its order paid), redeemed at the door or not; the event's own
 * staff need none. Free and external events are unchanged.
 *
 * And the decision this records: letting a ticket in at the door does not
 * check its holder in. Check-in is the attendee's own act, at the venue, from
 * their phone (docs/CHECKIN.md).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")

const w = newWorld()
let restore: () => void
let fake: FakeRazorpay

const LAT = 12.9784
const LNG = 77.6408

beforeAll(() => {
  restore = ticketEnv()
  fake = fakeRazorpay()
})
afterAll(async () => {
  jest.restoreAllMocks()
  await db.event_check_ins.deleteMany({ where: { event_id: { in: w.events } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: w.events } } })
  await teardown(w)
  restore()
  await closeDb()
})

/** A native ticketed event that is on now, fenced around Bengaluru. */
async function liveTicketedEvent() {
  const world = await ticketedEvent(w, [{ quantity: 10 }])
  await db.events.update({
    where: { id: world.eventId },
    data: { latitude: LAT, longitude: LNG, geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 }, city: "Bengaluru" },
  })
  return world
}

async function tokenFor(userId: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  return signAccessToken(userId, u.email)
}

const checkIn = async (eventId: string, userId: string) =>
  checkinRoute.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await tokenFor(userId)}` },
      body: JSON.stringify({ latitude: LAT, longitude: LNG }),
    }),
    { params: Promise.resolve({ eventId }) }
  )

describe("check-in on a native ticketed event", () => {
  it("refuses someone with no ticket, with tickets_required", async () => {
    const { eventId } = await liveTicketedEvent()
    const walkIn = await buyer(w)
    const res = await checkIn(eventId, walkIn)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ errorCode: "tickets_required" })
    expect(await db.event_check_ins.count({ where: { event_id: eventId, user_id: walkIn } })).toBe(0)
  })

  it("lets a ticket holder in, before the door has seen the ticket and after", async () => {
    const { eventId, host, typeIds } = await liveTicketedEvent()
    const a = await buyer(w)
    const { orderRef } = await heldOrder(fake, eventId, a, [{ ticketTypeId: typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    expect((await checkIn(eventId, a)).status).toBe(200)

    // The door letting a second holder's ticket in does not check them in: that stays their own act.
    const b = await buyer(w)
    const held = await heldOrder(fake, eventId, b, [{ ticketTypeId: typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(held.orderRef)))
    await settled()
    const code = (await db.tickets.findFirstOrThrow({ where: { order_id: held.orderId } })).door_code
    expect(await admitAtDoor(eventId, { id: host, role: "organizer" }, { code })).toMatchObject({ kind: "let_in" })
    expect(await db.event_check_ins.count({ where: { event_id: eventId, user_id: b } })).toBe(0)
    expect((await checkIn(eventId, b)).status).toBe(200)
  })

  it("refuses a holder whose order was refunded", async () => {
    const { eventId, typeIds } = await liveTicketedEvent()
    const a = await buyer(w)
    const { orderRef, orderId } = await heldOrder(fake, eventId, a, [{ ticketTypeId: typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    await db.ticket_orders.update({ where: { id: orderId }, data: { status: "refunded", refunded_minor: 1, refunded_at: new Date(), provider_refund_ref: `rfnd_${testId("r").slice(-12)}` } })
    expect((await checkIn(eventId, a)).status).toBe(403)
  })

  it("needs no ticket from the event's own staff", async () => {
    const { eventId, orgId } = await liveTicketedEvent()
    const staff = await makeUser(testId("tix-ci-staff"), "organizer")
    w.users.push(staff)
    await db.profiles.create({ data: { id: staff, name: "Staff", onboarded: true } })
    await db.organisation_members.create({ data: { org_id: orgId, user_id: staff, role: "staff" } })
    expect((await checkIn(eventId, staff)).status).toBe(200)
  })

  it("control: the same walk-in checks in once the event is free again", async () => {
    const { eventId } = await liveTicketedEvent()
    await db.events.update({ where: { id: eventId }, data: { ticketing_mode: "off" } })
    expect((await checkIn(eventId, await buyer(w))).status).toBe(200)
  })

  it("control: with TICKETING off the guard is off too", async () => {
    const { eventId } = await liveTicketedEvent()
    const walkIn = await buyer(w)
    process.env.TICKETING = "false"
    try {
      expect((await checkIn(eventId, walkIn)).status).toBe(200)
    } finally {
      process.env.TICKETING = "true"
    }
  })
})
