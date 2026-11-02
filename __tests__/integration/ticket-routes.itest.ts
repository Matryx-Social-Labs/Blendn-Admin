import { NextRequest } from "next/server"

import { signAccessToken } from "@/lib/mobile-auth"
import { verifyPayToken } from "@/lib/ticket-pay-token"
import { verifyTicketQr } from "@/lib/tickets"

import { closeDb, db, testId } from "./helpers"
import {
  buyer,
  capturedDelivery,
  deliver,
  fakeRazorpay,
  newWorld,
  settled,
  teardown,
  ticketedEvent,
  ticketEnv,
  typeRow,
  type FakeRazorpay,
} from "./ticket-world"

/**
 * The mobile ticket routes against real Postgres (SCRUM-1011, contract §1–3,
 * §5–6 and §8 v1.1), through the real route handlers with a real JWT. Razorpay
 * is ticket-world's fake.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
const quoteRoute = require("@/app/api/mobile/events/[eventId]/ticket-quote/route") as typeof import("@/app/api/mobile/events/[eventId]/ticket-quote/route")
const ordersRoute = require("@/app/api/mobile/events/[eventId]/ticket-orders/route") as typeof import("@/app/api/mobile/events/[eventId]/ticket-orders/route")
const orderRoute = require("@/app/api/mobile/ticket-orders/[orderId]/route") as typeof import("@/app/api/mobile/ticket-orders/[orderId]/route")
const myTicketsRoute = require("@/app/api/mobile/me/tickets/route") as typeof import("@/app/api/mobile/me/tickets/route")
const rsvpRoute = require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
const payStatusRoute = require("@/app/pay/o/[orderId]/status/route") as typeof import("@/app/pay/o/[orderId]/status/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const w = newWorld()
let restoreEnv: () => void
let rzp: FakeRazorpay

beforeAll(() => {
  restoreEnv = ticketEnv()
})
beforeEach(() => {
  rzp = fakeRazorpay()
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  await teardown(w)
  restoreEnv()
  await closeDb()
})

let ip = 0
/** Each request from its own address unless told, so the per-IP limits only bite where a test means them to. */
function req(path: string, userId: string, init: { method?: string; body?: unknown; ip?: string } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${signAccessToken(userId, `${userId}@itest.invalid`)}`,
      "content-type": "application/json",
      "x-real-ip": init.ip ?? `10.9.${Math.floor(++ip / 250)}.${ip % 250}`,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}
const params = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) })
const json = async (res: Response) => ({ status: res.status, body: res.status === 204 ? null : await res.json() })

const getEvent = (eventId: string, userId: string) => eventRoute.GET(req(`/api/mobile/events/${eventId}`, userId), params("eventId", eventId)).then(json)
const quote = (eventId: string, userId: string, lines: unknown, ipAddr?: string) =>
  quoteRoute.POST(req(`/api/mobile/events/${eventId}/ticket-quote`, userId, { method: "POST", body: { lines }, ip: ipAddr }), params("eventId", eventId)).then(json)
const order = (eventId: string, userId: string, lines: unknown, ipAddr?: string) =>
  ordersRoute.POST(req(`/api/mobile/events/${eventId}/ticket-orders`, userId, { method: "POST", body: { lines }, ip: ipAddr }), params("eventId", eventId)).then(json)
const getOrder = (orderId: string, userId: string) => orderRoute.GET(req(`/api/mobile/ticket-orders/${orderId}`, userId), params("orderId", orderId)).then(json)
const deleteOrder = (orderId: string, userId: string) => orderRoute.DELETE(req(`/api/mobile/ticket-orders/${orderId}`, userId, { method: "DELETE" }), params("orderId", orderId)).then(json)
const myTickets = (userId: string, eventId?: string) => myTicketsRoute.GET(req(`/api/mobile/me/tickets${eventId ? `?eventId=${eventId}` : ""}`, userId)).then(json)

async function pay(orderId: string) {
  const row = await db.ticket_orders.findUniqueOrThrow({ where: { id: orderId }, select: { provider_order_ref: true } })
  const payment = rzp.capture(row.provider_order_ref!)
  await deliver(capturedDelivery("payment.captured", payment))
  await settled()
  return payment
}

describe("GET /events/:id `ticketing`", () => {
  it("lists on-sale types by position, never a hidden or free one; remaining only at 20 or fewer; mine once paid", async () => {
    const ev = await ticketedEvent(w, [
      { quantity: 500, price: 79_900 },
      { quantity: 30, price: 49_900, sold: 12 },
      { quantity: 5, price: 99_900, hidden: true },
      { quantity: 50, price: 0 },
      { quantity: 10, price: 29_900, startsAt: new Date(Date.now() + 86_400_000) },
      { quantity: 4, price: 19_900, sold: 4 },
    ])
    const b = await buyer(w)

    const before = await getEvent(ev.eventId, b)
    expect(before.status).toBe(200)
    expect(before.body.data.ticketing).toEqual({
      mode: "native",
      currency: "INR",
      fromMinor: 49_900,
      feesAbsorbed: false,
      refundPolicy: "none",
      types: [
        expect.objectContaining({ id: ev.typeIds[0], name: "Tier 0", priceMinor: 79_900, status: "on_sale", remaining: null, maxPerOrder: 10, description: null, salesStartAt: null, salesEndAt: null }),
        expect.objectContaining({ id: ev.typeIds[1], status: "on_sale", remaining: 18 }),
        expect.objectContaining({ id: ev.typeIds[4], status: "not_started", remaining: null }),
        expect.objectContaining({ id: ev.typeIds[5], status: "sold_out", remaining: null }),
      ],
      mine: null,
    })

    const created = await order(ev.eventId, b, [{ typeId: ev.typeIds[1], quantity: 2 }])
    expect((await getEvent(ev.eventId, b)).body.data.ticketing.mine).toBeNull()
    await pay(created.body.data.orderId)
    expect((await getEvent(ev.eventId, b)).body.data.ticketing.mine).toEqual({ ticketCount: 2, orderIds: [created.body.data.orderId] })
  })

  it("an external event names the link's own host, www. stripped, and nothing else", async () => {
    const ev = await ticketedEvent(w, [])
    await db.events.update({
      where: { id: ev.eventId },
      data: { ticketing_mode: "external", external_ticket_url: "https://www.eventbrite.ca/e/mixer-123?aff=x" },
    })
    expect((await getEvent(ev.eventId, await buyer(w))).body.data.ticketing).toEqual({
      mode: "external",
      externalUrl: "https://www.eventbrite.ca/e/mixer-123?aff=x",
      externalSite: "eventbrite.ca",
    })
  })

  it("is null with TICKETING off, and every ticket route is a 404", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 5 }])
    const b = await buyer(w)
    const held = await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])
    process.env.TICKETING = "false"
    try {
      expect((await getEvent(ev.eventId, b)).body.data.ticketing).toBeNull()
      expect((await quote(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])).status).toBe(404)
      expect((await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])).status).toBe(404)
      expect((await getOrder(held.body.data.orderId, b)).status).toBe(404)
      expect((await deleteOrder(held.body.data.orderId, b)).status).toBe(404)
      expect((await myTickets(b)).status).toBe(404)
    } finally {
      process.env.TICKETING = "true"
    }
  })
})

describe("POST /events/:id/ticket-quote", () => {
  it("prices the lines with the fee parts and the market's tax label, and holds nothing", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10, price: 49_900 }])
    const res = await quote(ev.eventId, await buyer(w), [{ typeId: ev.typeIds[0], quantity: 2 }])

    expect(res.status).toBe(200)
    const q = res.body.data
    expect(q).toMatchObject({ currency: "INR", subtotalMinor: 99_800, taxLabel: "GST", lines: [{ typeId: ev.typeIds[0], quantity: 2, unitMinor: 49_900 }] })
    expect(q.bookingFeeMinor).toBe(q.feeParts.serviceMinor + q.feeParts.taxMinor + q.feeParts.processingMinor)
    expect(q.totalMinor).toBe(q.subtotalMinor + q.bookingFeeMinor)
    expect((await typeRow(ev.typeIds[0])).held).toBe(0)
  })

  it("counts a lapsed hold as free, as the order would: the last seat is quotable before the sweeper passes", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 1 }])
    const first = (await order(ev.eventId, await buyer(w), [{ typeId: ev.typeIds[0], quantity: 1 }])).body.data
    const late = await buyer(w)
    expect((await quote(ev.eventId, late, [{ typeId: ev.typeIds[0], quantity: 1 }])).body.errorCode).toBe("sold_out")
    await db.ticket_orders.update({ where: { id: first.orderId }, data: { hold_expires_at: new Date(Date.now() - 60_000) } })
    expect((await quote(ev.eventId, late, [{ typeId: ev.typeIds[0], quantity: 1 }])).status).toBe(200)
  })

  it("with fees absorbed: no booking fee and no fee parts for the buyer", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10, price: 49_900 }], { absorbed: true })
    const q = (await quote(ev.eventId, await buyer(w), [{ typeId: ev.typeIds[0], quantity: 1 }])).body.data
    expect(q).toMatchObject({ subtotalMinor: 49_900, bookingFeeMinor: 0, totalMinor: 49_900 })
    expect(q).not.toHaveProperty("feeParts")
  })

  it.each([
    ["sold_out", { quantity: 1, sold: 1 }, 1],
    ["not_on_sale", { quantity: 5, startsAt: new Date(Date.now() + 86_400_000) }, 1],
    ["over_order_limit", { quantity: 50, max: 2 }, 3],
    ["unknown_ticket_type", { quantity: 5, hidden: true }, 1],
  ] as const)("refuses %s with a 409 and that errorCode", async (code, spec, quantity) => {
    const ev = await ticketedEvent(w, [spec])
    const res = await quote(ev.eventId, await buyer(w), [{ typeId: ev.typeIds[0], quantity }])
    expect(res).toMatchObject({ status: 409, body: { success: false, errorCode: code } })
  })

  it("refuses an under-age buyer as `age`, and more than ten seats for one buyer as over_buyer_limit", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 50, max: 10 }])
    await db.events.update({ where: { id: ev.eventId }, data: { min_age: 21 } })
    const young = await buyer(w)
    await db.profiles.update({ where: { id: young }, data: { date_of_birth: new Date(Date.UTC(new Date().getUTCFullYear() - 19, 0, 1)) } })
    expect((await quote(ev.eventId, young, [{ typeId: ev.typeIds[0], quantity: 1 }])).body.errorCode).toBe("age")

    const ev2 = await ticketedEvent(w, [{ quantity: 50, max: 10 }])
    const b = await buyer(w)
    await order(ev2.eventId, b, [{ typeId: ev2.typeIds[0], quantity: 8 }])
    expect((await quote(ev2.eventId, b, [{ typeId: ev2.typeIds[0], quantity: 3 }])).body.errorCode).toBe("over_buyer_limit")
  })

  it("a stranger's private event, and a draft, are not found", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 5 }])
    await db.events.update({ where: { id: ev.eventId }, data: { visibility: "private" } })
    expect((await quote(ev.eventId, await buyer(w), [{ typeId: ev.typeIds[0], quantity: 1 }])).status).toBe(404)
    const draft = await ticketedEvent(w, [{ quantity: 5 }])
    await db.events.update({ where: { id: draft.eventId }, data: { status: "draft" } })
    expect((await quote(draft.eventId, await buyer(w), [{ typeId: draft.typeIds[0], quantity: 1 }])).status).toBe(404)
  })

  it.each([[[]], [[{ typeId: "nope", quantity: 1 }]], [[{ typeId: "6f1c2b8e-4c1a-4f7e-9a3b-2d5e8f0a1b2c", quantity: 0 }]], ["lines"]])("answers %p with a 400, never a 500", async (lines) => {
    const ev = await ticketedEvent(w, [{ quantity: 5 }])
    expect((await quote(ev.eventId, await buyer(w), lines)).status).toBe(400)
  })

  it("is limited per user", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 5 }])
    const b = await buyer(w)
    const statuses = []
    for (let i = 0; i < 62; i++) statuses.push((await quote(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])).status)
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })
})

describe("POST /events/:id/ticket-orders", () => {
  it("holds the seats, charges the database's total, and returns a pay link bound to the order and buyer", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10, price: 49_900 }])
    const b = await buyer(w)

    const res = await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 2 }])

    expect(res.status).toBe(201)
    const o = res.body.data
    const row = await db.ticket_orders.findUniqueOrThrow({ where: { id: o.orderId } })
    expect(o).toEqual({ orderId: row.id, status: "pending", totalMinor: row.total_minor, currency: "INR", holdExpiresAt: row.hold_expires_at.toISOString(), payUrl: expect.any(String) })
    expect(rzp.orders.get(row.provider_order_ref!)).toEqual({ amount: row.total_minor, currency: "INR", receipt: row.id })
    const url = new URL(o.payUrl)
    expect(`${url.origin}${url.pathname}`).toBe(`https://pay.itest.invalid/pay/o/${row.id}`)
    expect(verifyPayToken(url.searchParams.get("t"), row.id, b)).toBe("ok")
    expect((await typeRow(ev.typeIds[0])).held).toBe(2)
  })

  it("gives the hold back and says so when Razorpay cannot make the order", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    rzp.failOnce.add("POST /orders")
    const res = await order(ev.eventId, await buyer(w), [{ typeId: ev.typeIds[0], quantity: 2 }])
    expect(res.status).toBe(503)
    expect((await typeRow(ev.typeIds[0])).held).toBe(0)
    expect(await db.ticket_orders.count({ where: { event_id: ev.eventId, status: "cancelled" } })).toBe(1)
  })

  it("refuses a third open hold as too_many_holds", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])
    await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])
    expect((await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])).body).toMatchObject({ errorCode: "too_many_holds" })
  })

  it("is limited per user and per network", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 100, max: 1 }])
    const b = await buyer(w)
    const mine = []
    for (let i = 0; i < 11; i++) mine.push((await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])).status)
    expect(mine.at(-1)).toBe(429)

    const net = `10.77.${testId("n").length}.1`
    const shared = []
    for (let i = 0; i < 31; i++) shared.push((await order(ev.eventId, await buyer(w), [{ typeId: "6f1c2b8e-4c1a-4f7e-9a3b-2d5e8f0a1b2c", quantity: 1 }], net)).status)
    expect(shared.slice(0, 30).every((s) => s !== 429)).toBe(true)
    expect(shared.at(-1)).toBe(429)
  })
})

describe("GET and DELETE /ticket-orders/:id", () => {
  it("the buyer reads it, tickets only once paid; anyone else gets a 404", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const { orderId } = (await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 2 }])).body.data

    const first = await getOrder(orderId, b)
    expect(first).toMatchObject({ status: 200 })
    expect(first.body.data).toMatchObject({ orderId, eventId: ev.eventId, status: "pending", paymentFailed: false, tickets: [] })
    expect((await getOrder(orderId, await buyer(w))).status).toBe(404)
    expect((await getOrder("6f1c2b8e-4c1a-4f7e-9a3b-2d5e8f0a1b2c", b)).status).toBe(404)

    await pay(orderId)
    const paid = (await getOrder(orderId, b)).body.data
    expect(paid.status).toBe("paid")
    expect(paid.tickets).toHaveLength(2)
    expect(verifyTicketQr(paid.tickets[0].qrPayload)).toBe(paid.tickets[0].ticketId)
  })

  it("says the last attempt failed, from Razorpay's payment.failed, until the pay page starts another", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const created = (await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])).body.data
    const row = await db.ticket_orders.findUniqueOrThrow({ where: { id: created.orderId } })

    await deliver({
      entity: "event",
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_failedattempt1", order_id: row.provider_order_ref, amount: row.total_minor, currency: "INR", status: "failed", error_code: "BAD_REQUEST_ERROR" } } },
      created_at: Math.floor(Date.now() / 1000),
    })
    expect((await getOrder(created.orderId, b)).body.data.paymentFailed).toBe(true)

    const t = new URL(created.payUrl).searchParams.get("t")!
    const attempt = await payStatusRoute.POST(new NextRequest(`http://localhost/pay/o/${created.orderId}/status?t=${encodeURIComponent(t)}`, { method: "POST" }), params("orderId", created.orderId))
    expect(attempt.status).toBe(204)
    expect((await getOrder(created.orderId, b)).body.data.paymentFailed).toBe(false)
  })

  it("the buyer lets a pending hold go: 204, cancelled, seats back; then 409; anyone else 404", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const { orderId } = (await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 3 }])).body.data

    expect((await deleteOrder(orderId, await buyer(w))).status).toBe(404)
    expect((await deleteOrder(orderId, b)).status).toBe(204)
    expect((await db.ticket_orders.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("cancelled")
    expect((await typeRow(ev.typeIds[0])).held).toBe(0)
    expect((await deleteOrder(orderId, b)).status).toBe(409)
  })
})

describe("GET /me/tickets", () => {
  it("my paid tickets with their event, for one event or all; never anyone else's", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const { orderId } = (await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 2 }])).body.data
    expect((await myTickets(b)).body.data).toEqual([])
    await pay(orderId)

    const all = (await myTickets(b)).body.data
    expect(all).toHaveLength(2)
    const event = await db.events.findUniqueOrThrow({ where: { id: ev.eventId } })
    expect(all[0]).toEqual({
      ticketId: expect.any(String),
      orderId,
      eventId: ev.eventId,
      typeName: "Tier 0",
      doorCode: expect.stringMatching(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/),
      qrPayload: expect.any(String),
      redeemedAt: null,
      event: { id: ev.eventId, title: event.title, startsAt: event.start_time.toISOString(), endsAt: event.end_time.toISOString(), timezone: "UTC", venueName: null, coverUrl: null },
    })
    expect(verifyTicketQr(all[0].qrPayload)).toBe(all[0].ticketId)
    expect((await myTickets(b, ev.eventId)).body.data).toHaveLength(2)
    expect((await myTickets(b, "6f1c2b8e-4c1a-4f7e-9a3b-2d5e8f0a1b2c")).body.data).toEqual([])
    expect((await myTickets(await buyer(w))).body.data).toEqual([])
    expect((await myTickets(b, "not-a-uuid")).status).toBe(400)
  })
})

describe("RSVP on a native ticketed event", () => {
  it("is refused with 409 tickets_required; the ticket writes it", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const res = await rsvpRoute.POST(req(`/api/mobile/events/${ev.eventId}/rsvp`, b, { method: "POST", body: { status: "going" } }), params("eventId", ev.eventId)).then(json)
    expect(res).toMatchObject({ status: 409, body: { errorCode: "tickets_required" } })
    expect(await db.event_rsvps.count({ where: { event_id: ev.eventId, user_id: b } })).toBe(0)
  })

  it("is allowed while TICKETING is off: the app shows the RSVP then", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    process.env.TICKETING = "false"
    try {
      const res = await rsvpRoute.POST(req(`/api/mobile/events/${ev.eventId}/rsvp`, b, { method: "POST", body: { status: "going" } }), params("eventId", ev.eventId))
      expect(res.status).toBeLessThan(300)
    } finally {
      process.env.TICKETING = "true"
    }
  })
})

describe("the pay page's status door", () => {
  async function linked() {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const created = (await order(ev.eventId, b, [{ typeId: ev.typeIds[0], quantity: 1 }])).body.data
    return { ...created, t: new URL(created.payUrl).searchParams.get("t")!, buyerId: b }
  }
  const status = (orderId: string, t: string) =>
    payStatusRoute.GET(new NextRequest(`http://localhost/pay/o/${orderId}/status?t=${encodeURIComponent(t)}`), params("orderId", orderId)).then(json)

  it("answers the order's status to its token, with no-store", async () => {
    const o = await linked()
    const res = await payStatusRoute.GET(new NextRequest(`http://localhost/pay/o/${o.orderId}/status?t=${encodeURIComponent(o.t)}`), params("orderId", o.orderId))
    expect(res.headers.get("cache-control")).toContain("no-store")
    expect(await res.json()).toEqual({ status: "pending", paymentFailed: false, holdExpiresAt: o.holdExpiresAt })
  })

  it("refuses a tampered token, an expired one, and one for another order", async () => {
    const a = await linked()
    const b = await linked()
    expect((await status(a.orderId, `${a.t.slice(0, -2)}xx`)).status).toBe(401)
    expect((await status(b.orderId, a.t)).status).toBe(401)
    const [exp] = a.t.split(".")
    jest.spyOn(Date, "now").mockReturnValue((Number(exp) + 1) * 1000)
    expect((await status(a.orderId, a.t)).status).toBe(401)
  })
})
