import { NextRequest } from "next/server"

/* The session is the only input the audit log reader trusts. */
import { getAuditLog } from "@/lib/audit-actions"
import { signAccessToken } from "@/lib/mobile-auth"
import { actorFor } from "@/lib/org-membership"
import { reconcileTicketPayments } from "@/lib/ticket-reconcile"
import { refundOrder } from "@/lib/ticket-refunds"
import { salesPage, ticketsSummary } from "@/lib/ticket-sales"
import { executeRefund } from "@/lib/ticket-settle"
import { missingTicketAtCheckIn } from "@/lib/ticket-views"
import { redeemTicket } from "@/lib/tickets"

import { closeDb, db } from "./helpers"
import { buyer, capturedDelivery, deliver, fakeRazorpay, heldOrder, newWorld, orderRow, refundDelivery, settled, teardown, ticketedEvent, ticketEnv, typeRow, type FakeRazorpay } from "./ticket-world"

/**
 * A buyer's own refund (SCRUM-1113, owner 2026-11-25): automatic inside the
 * event's refund window, the full ticket price, absorbed fees charged to the
 * organization; the same amount from the organizer's Refund button. Real
 * Postgres, the real route and JWT, ticket-world's fake Razorpay.
 */

let session: { user: { id: string; role: string; signedInAt: number } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => session, getInviteAuth: async () => session }))

/* eslint-disable @typescript-eslint/no-require-imports */
const refundRoute = require("@/app/api/mobile/ticket-orders/[orderId]/refund-request/route") as typeof import("@/app/api/mobile/ticket-orders/[orderId]/refund-request/route")
const orderRoute = require("@/app/api/mobile/ticket-orders/[orderId]/route") as typeof import("@/app/api/mobile/ticket-orders/[orderId]/route")
const myTicketsRoute = require("@/app/api/mobile/me/tickets/route") as typeof import("@/app/api/mobile/me/tickets/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const HOUR = 3_600_000
const DAY = 24 * HOUR
const PRICE = 49_900

const w = newWorld()
let restoreEnv: () => void
let rzp: FakeRazorpay

beforeAll(() => {
  restoreEnv = ticketEnv()
})
beforeEach(() => {
  rzp = fakeRazorpay()
})
afterEach(() => {
  jest.restoreAllMocks()
  session = null
})
afterAll(async () => {
  await teardown(w)
  restoreEnv()
  await closeDb()
})

type Policy = "none" | "until_7d" | "until_24h"

/** A paid order on an event `startsIn` from now, its payout transferred and held. */
async function paid(opts: { policy?: Policy; startsIn?: number; absorbed?: boolean; quantity?: number; account?: null } = {}) {
  const ev = await ticketedEvent(w, [{ quantity: 10, price: PRICE }, { quantity: 10, price: 149_900 }], { absorbed: opts.absorbed, ...(opts.account === null ? { account: null } : {}) })
  const start = new Date(Date.now() + (opts.startsIn ?? 30 * DAY))
  await db.events.update({ where: { id: ev.eventId }, data: { refund_policy: opts.policy ?? "until_24h", start_time: start, end_time: new Date(start.getTime() + 4 * HOUR) } })
  const buyerId = await buyer(w)
  const held = await heldOrder(rzp, ev.eventId, buyerId, [{ ticketTypeId: ev.typeIds[0], quantity: opts.quantity ?? 1 }])
  const payment = rzp.capture(held.orderRef)
  await deliver(capturedDelivery("payment.captured", payment))
  await settled()
  const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: held.orderId } })
  const fees = order.service_fee_minor + order.service_fee_tax_minor + order.processing_fee_minor
  return { ...ev, buyerId, orderId: held.orderId, paymentId: payment.id, order, fees, start }
}

const req = (path: string, userId: string, method = "GET") =>
  new NextRequest(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${signAccessToken(userId, `${userId}@itest.invalid`)}` } })

async function ask(orderId: string, userId: string) {
  const res = await refundRoute.POST(req(`/api/mobile/ticket-orders/${orderId}/refund-request`, userId, "POST"), { params: Promise.resolve({ orderId }) })
  return { status: res.status, body: await res.json() }
}
const readOrder = async (orderId: string, userId: string) =>
  (await (await orderRoute.GET(req(`/api/mobile/ticket-orders/${orderId}`, userId), { params: Promise.resolve({ orderId }) })).json()).data
const myTickets = async (userId: string) => (await (await myTicketsRoute.GET(req("/api/mobile/me/tickets", userId))).json()).data
const payoutOf = (orderId: string) => db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })
const unclaimed = async (orderId: string) => expect((await db.ticket_orders.findUniqueOrThrow({ where: { id: orderId } })).refund_requested_at).toBeNull()

/** What each party has in the end, from the fake's records and our row: it must be what the buyer paid. */
async function books(o: Awaited<ReturnType<typeof paid>>) {
  const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: o.orderId } })
  const payout = await db.ticket_payouts.findUnique({ where: { order_id: o.orderId } })
  const buyerBack = (rzp.refunds.get(o.paymentId) ?? []).reduce((s, r) => s + r.amount, 0)
  const transferred = (rzp.transfers.get(o.paymentId) ?? []).reduce((s, t) => s + t.amount, 0)
  const reversed = rzp.reversals.filter((r) => rzp.transfers.get(o.paymentId)?.some((t) => t.id === r.transfer_id)).reduce((s, r) => s + r.amount, 0)
  const debit = payout?.org_debit_minor ?? 0
  const razorpay = order.processing_fee_minor
  const host = transferred - reversed - debit
  const blendn = order.total_minor - razorpay - buyerBack - (transferred - reversed) + debit
  return { paid: order.total_minor, buyerBack, host, blendn, razorpay }
}

describe("a buyer's refund inside the window", () => {
  it("refunds the ticket price at once, keeps the booking fee, frees the seats and takes the share back", async () => {
    const o = await paid({ quantity: 2 })

    const { status, body } = await ask(o.orderId, o.buyerId)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      orderId: o.orderId,
      status: "refunded",
      message: "Refund started. It can take 5–7 business days to reach you.",
      refund: { state: "refunded", amountMinor: 2 * PRICE, currency: "INR" },
      refundOffer: null,
      tickets: [],
    })
    expect(rzp.refunds.get(o.paymentId)).toEqual([expect.objectContaining({ amount: 2 * PRICE })])
    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", refunded_minor: 2 * PRICE, refund_reason: "buyer_request" })
    expect(await typeRow(o.typeIds[0])).toMatchObject({ sold: 0, held: 0 })
    expect(await db.event_rsvps.count({ where: { event_id: o.eventId, user_id: o.buyerId } })).toBe(0)
    expect(await payoutOf(o.orderId)).toMatchObject({ status: "reversed", reversed_minor: 2 * PRICE, org_debit_minor: 0 })
    expect(await books(o)).toEqual({ paid: o.order.total_minor, buyerBack: 2 * PRICE, host: 0, blendn: o.order.service_fee_minor + o.order.service_fee_tax_minor, razorpay: o.order.processing_fee_minor })
  })

  it("gives back everything paid when the host absorbed the fees, and charges the host the fees", async () => {
    const o = await paid({ absorbed: true, quantity: 3 })
    expect(o.fees).toBeGreaterThan(0)

    expect((await ask(o.orderId, o.buyerId)).body.data.refund.amountMinor).toBe(3 * PRICE)

    expect(rzp.refunds.get(o.paymentId)).toEqual([expect.objectContaining({ amount: o.order.total_minor })])
    expect(await payoutOf(o.orderId)).toMatchObject({ status: "reversed", reversed_minor: 3 * PRICE - o.fees, org_debit_minor: o.fees })
    const b = await books(o)
    expect(b).toEqual({ paid: 3 * PRICE, buyerBack: 3 * PRICE, host: -o.fees, blendn: o.order.service_fee_minor + o.order.service_fee_tax_minor, razorpay: o.order.processing_fee_minor })
    expect(b.buyerBack + b.host + b.blendn + b.razorpay).toBe(b.paid)
  })

  it("charges the host the fees when the share was never transferred", async () => {
    const o = await paid({ absorbed: true, account: null })
    expect((await payoutOf(o.orderId)).status).toBe("no_account")
    await ask(o.orderId, o.buyerId)
    expect(await payoutOf(o.orderId)).toMatchObject({ status: "reversed", reversed_minor: 0, org_debit_minor: o.fees })
    const b = await books(o)
    expect(b.buyerBack + b.host + b.blendn + b.razorpay).toBe(b.paid)
  })

  it("is the same amount from the organizer's Refund button, and the panel says what it charges", async () => {
    const o = await paid({ absorbed: true, quantity: 2 })
    const host = { id: o.host, role: "organizer" as const }
    const row = (await salesPage(await actorFor(host), o.eventId, { page: 1 }))!.rows[0]
    expect(row).toMatchObject({ refundMinor: 2 * PRICE, chargedFeesMinor: o.fees })

    expect(await refundOrder(o.orderId, host, "organizer")).toEqual({ ok: true })

    expect(rzp.refunds.get(o.paymentId)).toEqual([expect.objectContaining({ amount: 2 * PRICE })])
    expect((await payoutOf(o.orderId)).org_debit_minor).toBe(o.fees)
  })

  it("answers started when Razorpay fails, keeps the claim, and the reconcile job finishes it with the books right", async () => {
    const o = await paid({ absorbed: true })
    rzp.failOnce.add(`POST /payments/${o.paymentId}/refund`)

    const { status, body } = await ask(o.orderId, o.buyerId)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ status: "paid", refund: { state: "started", amountMinor: PRICE, refundedAt: null }, refundOffer: null })
    expect(rzp.refunds.get(o.paymentId)).toBeUndefined()

    await db.ticket_orders.update({ where: { id: o.orderId }, data: { refund_requested_at: new Date(Date.now() - 10 * 60_000) } })
    await reconcileTicketPayments()

    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", refunded_minor: PRICE })
    const b = await books(o)
    expect(b.host).toBe(-o.fees)
    expect(b.buyerBack + b.host + b.blendn + b.razorpay).toBe(b.paid)
  })

  it("retries a reversal that failed after the refund was recorded, once", async () => {
    const o = await paid({ absorbed: true })
    const transfer = rzp.transfers.get(o.paymentId)![0]
    rzp.failOnce.add(`POST /transfers/${transfer.id}/reversals`)

    expect((await ask(o.orderId, o.buyerId)).status).toBe(200)
    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded" })
    expect((await payoutOf(o.orderId)).status).toBe("on_hold")

    await db.ticket_orders.update({ where: { id: o.orderId }, data: { refunded_at: new Date(Date.now() - 10 * 60_000) } })
    await reconcileTicketPayments()
    await reconcileTicketPayments()

    expect(rzp.reversals).toEqual([{ transfer_id: transfer.id, amount: PRICE - o.fees }])
    expect(await payoutOf(o.orderId)).toMatchObject({ status: "reversed", org_debit_minor: o.fees })
  })

  it("does not reverse twice when Razorpay reversed and our record of it was lost", async () => {
    const o = await paid({ absorbed: true })
    const transfer = rzp.transfers.get(o.paymentId)![0]
    await ask(o.orderId, o.buyerId)
    // As a crash between Razorpay's reversal and our commit leaves it.
    await db.ticket_payouts.update({ where: { order_id: o.orderId }, data: { status: "on_hold", reversed_minor: 0, org_debit_minor: 0 } })
    await db.ticket_orders.update({ where: { id: o.orderId }, data: { refunded_at: new Date(Date.now() - 10 * 60_000) } })

    await reconcileTicketPayments()

    expect(rzp.reversals.filter((r) => r.transfer_id === transfer.id)).toHaveLength(1)
    expect(await payoutOf(o.orderId)).toMatchObject({ status: "reversed", reversed_minor: PRICE - o.fees, org_debit_minor: o.fees })
  })

  it("is idempotent: asked twice, at once and again later, it is one refund and one answer", async () => {
    const o = await paid({ quantity: 2 })
    const [a, b] = await Promise.all([ask(o.orderId, o.buyerId), ask(o.orderId, o.buyerId)])
    const c = await ask(o.orderId, o.buyerId)

    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect(c.body.data).toMatchObject({ status: "refunded", refund: { state: "refunded", amountMinor: 2 * PRICE } })
    expect(rzp.refunds.get(o.paymentId)).toHaveLength(1)
    expect(await db.audit_logs.count({ where: { action: "ticket_order.buyer_refund", resource_id: o.orderId } })).toBe(1)
  })

  it("never deadlocks: asking, Razorpay's webhook and the retry at once all answer, on one refund", async () => {
    for (const account of [undefined, null] as const) {
      const o = await paid({ absorbed: true, ...(account === null ? { account } : {}) })
      rzp.failOnce.add(`POST /payments/${o.paymentId}/refund`)
      await ask(o.orderId, o.buyerId)
      rzp.refunds.set(o.paymentId, [{ id: `rfnd_${o.orderId.slice(0, 12)}`, payment_id: o.paymentId, amount: PRICE, currency: "INR", status: "processed" }])
      const asks = Array.from({ length: 4 }, () => ask(o.orderId, o.buyerId))
      const results = await Promise.all([
        ...asks,
        deliver(refundDelivery({ id: `rfnd_${o.orderId.slice(0, 12)}`, payment_id: o.paymentId, amount: PRICE })),
        executeRefund(o.orderId).then(() => ({ status: 200 })),
      ])
      await settled()
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(200))
      expect(rzp.refunds.get(o.paymentId)).toHaveLength(1)
      expect(await payoutOf(o.orderId)).toMatchObject({ status: "reversed", org_debit_minor: o.fees })
    }
  })

  it("a finish waits its turn behind a claim holding the payout, and both commit", async () => {
    const o = await paid({ absorbed: true, account: null })
    rzp.failOnce.add(`POST /payments/${o.paymentId}/refund`)
    await ask(o.orderId, o.buyerId)
    // A second ask mid-claim: the payout locked, the order not yet.
    let go = () => {}
    const gate = new Promise<void>((r) => (go = r))
    const second = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM ticket_payouts WHERE order_id = ${o.orderId}::uuid FOR UPDATE`
        await gate
        await tx.$queryRaw`SELECT 1 FROM ticket_orders WHERE id = ${o.orderId}::uuid FOR UPDATE`
      },
      { timeout: 20_000 }
    )
    await new Promise((r) => setTimeout(r, 100))
    const webhook = deliver(refundDelivery({ id: `rfnd_${o.orderId.slice(0, 12)}`, payment_id: o.paymentId, amount: PRICE }))
    await new Promise((r) => setTimeout(r, 300))
    go()
    await second
    expect((await webhook).body).toMatchObject({ applied: true })
    expect((await orderRow(o.orderId)).status).toBe("refunded")
  })

  it("Razorpay's refund.processed finishes it and records the host's charge", async () => {
    const o = await paid({ absorbed: true })
    rzp.failOnce.add(`POST /payments/${o.paymentId}/refund`)
    await ask(o.orderId, o.buyerId)
    await deliver(refundDelivery({ id: `rfnd_${o.orderId.slice(0, 12)}`, payment_id: o.paymentId, amount: PRICE }))
    await settled()
    expect(await payoutOf(o.orderId)).toMatchObject({ status: "reversed", org_debit_minor: o.fees })
  })
})

describe("the window is the event's policy, on the server's clock", () => {
  it.each<[string, Policy, number, boolean]>([
    ["no refunds", "none", 60 * DAY, false],
    ["7 days, a minute inside", "until_7d", 7 * DAY + 60_000, true],
    ["7 days, a minute late", "until_7d", 7 * DAY - 60_000, false],
    ["24 hours, a minute inside", "until_24h", DAY + 60_000, true],
    ["24 hours, a minute late", "until_24h", DAY - 60_000, false],
    ["24 hours, already started", "until_24h", -HOUR, false],
  ])("%s", async (_label, policy, startsIn, allowed) => {
    const o = await paid({ policy, startsIn: 60 * DAY })
    const start = new Date(Date.now() + startsIn)
    await db.events.update({ where: { id: o.eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 4 * HOUR) } })

    const view = await readOrder(o.orderId, o.buyerId)
    const { status, body } = await ask(o.orderId, o.buyerId)

    expect(view.refundOffer !== null).toBe(allowed)
    expect(status).toBe(allowed ? 200 : 409)
    if (allowed) return
    expect(body.errorCode).toBe(policy === "none" ? "refund_policy_none" : "refund_window_closed")
    await unclaimed(o.orderId)
    expect(rzp.refunds.get(o.paymentId)).toBeUndefined()
  })

  it("offers the exact amount, what is kept and until when, on the order and on every ticket", async () => {
    const o = await paid({ quantity: 2, policy: "until_7d" })
    const offer = { amountMinor: 2 * PRICE, bookingFeeMinor: o.order.total_minor - 2 * PRICE, currency: "INR", until: new Date(o.start.getTime() - 7 * DAY).toISOString() }
    expect(await readOrder(o.orderId, o.buyerId)).toMatchObject({ refund: null, refundOffer: offer })
    const tickets = await myTickets(o.buyerId)
    expect(tickets).toHaveLength(2)
    for (const t of tickets) expect(t).toMatchObject({ orderId: o.orderId, refund: null, refundOffer: offer })
  })

  it("keeps nothing back when the fees were absorbed", async () => {
    const o = await paid({ absorbed: true })
    expect((await readOrder(o.orderId, o.buyerId)).refundOffer).toMatchObject({ amountMinor: PRICE, bookingFeeMinor: 0 })
  })

  it("says the refund has started on the ticket until it lands, and hides it after", async () => {
    const o = await paid()
    rzp.failOnce.add(`POST /payments/${o.paymentId}/refund`)
    await ask(o.orderId, o.buyerId)
    expect(await myTickets(o.buyerId)).toEqual([expect.objectContaining({ refund: expect.objectContaining({ state: "started", amountMinor: PRICE }), refundOffer: null })])
    await deliver(refundDelivery({ id: `rfnd_${o.orderId.slice(0, 12)}`, payment_id: o.paymentId, amount: PRICE }))
    await settled()
    expect(await myTickets(o.buyerId)).toEqual([])
  })
})

describe("refused, claiming nothing", () => {
  it("to anyone but the buyer: another buyer, and the host, read not found", async () => {
    const o = await paid()
    for (const other of [await buyer(w), o.host]) expect((await ask(o.orderId, other)).status).toBe(404)
    expect((await ask("not-a-uuid", o.buyerId)).status).toBe(404)
    await unclaimed(o.orderId)
    // Control: the buyer may.
    expect((await ask(o.orderId, o.buyerId)).status).toBe(200)
  })

  it.each(["releasing", "released"] as const)("once the payout is %s", async (status) => {
    const o = await paid()
    await db.ticket_payouts.update({ where: { order_id: o.orderId }, data: { status, releasing_at: new Date(), ...(status === "released" ? { released_at: new Date() } : {}) } })
    expect((await readOrder(o.orderId, o.buyerId)).refundOffer).toBeNull()
    expect(await ask(o.orderId, o.buyerId)).toMatchObject({ status: 409, body: { errorCode: "payout_released" } })
    await unclaimed(o.orderId)
  })

  it("once one of its tickets was let in, while the host still may", async () => {
    const o = await paid({ quantity: 2 })
    const [ticket] = await db.tickets.findMany({ where: { order_id: o.orderId } })
    await db.tickets.update({ where: { id: ticket.id }, data: { redeemed_at: new Date() } })
    expect((await readOrder(o.orderId, o.buyerId)).refundOffer).toBeNull()
    expect(await ask(o.orderId, o.buyerId)).toMatchObject({ status: 409, body: { errorCode: "ticket_used" } })
    await unclaimed(o.orderId)
    expect(await refundOrder(o.orderId, { id: o.host, role: "organizer" }, "organizer")).toEqual({ ok: true })
  })

  it("for a canceled event, whose refund is the full one and not this", async () => {
    const o = await paid()
    await db.events.update({ where: { id: o.eventId }, data: { status: "cancelled" } })
    expect((await readOrder(o.orderId, o.buyerId)).refundOffer).toBeNull()
    expect(await ask(o.orderId, o.buyerId)).toMatchObject({ status: 409, body: { errorCode: "event_canceled" } })
    await unclaimed(o.orderId)
  })

  it("for an order not paid, and while ticketing or payments are off", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const held = await heldOrder(rzp, ev.eventId, b, [{ ticketTypeId: ev.typeIds[0], quantity: 1 }])
    expect(await ask(held.orderId, b)).toMatchObject({ status: 409, body: { errorCode: "not_paid" } })

    const o = await paid()
    const { TICKETING, RAZORPAY_KEY_ID } = process.env
    try {
      process.env.TICKETING = "false"
      expect((await ask(o.orderId, o.buyerId)).status).toBe(404)
      process.env.TICKETING = TICKETING
      delete process.env.RAZORPAY_KEY_ID
      expect((await ask(o.orderId, o.buyerId)).status).toBe(503)
    } finally {
      Object.assign(process.env, { TICKETING, RAZORPAY_KEY_ID })
    }
    await unclaimed(o.orderId)
  })

  it("waits for a release claim in flight, then is refused", async () => {
    const o = await paid()
    let commit = () => {}
    const committed = new Promise<void>((r) => (commit = r))
    const claim = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE ticket_payouts SET status = 'releasing', releasing_at = now() WHERE order_id = ${o.orderId}::uuid`
        await committed
      },
      { timeout: 20_000 }
    )
    await new Promise((r) => setTimeout(r, 100))
    const asked = ask(o.orderId, o.buyerId)
    await new Promise((r) => setTimeout(r, 300))
    commit()
    await claim
    expect(await asked).toMatchObject({ status: 409, body: { errorCode: "payout_released" } })
    await unclaimed(o.orderId)
  })
})

describe("a claimed refund and the door", () => {
  it("does not admit a ticket whose refund has started, and admits one whose has not", async () => {
    const o = await paid()
    const control = await paid()
    rzp.failOnce.add(`POST /payments/${o.paymentId}/refund`)
    await ask(o.orderId, o.buyerId)
    const redeem = async (x: typeof o) => {
      const t = await db.tickets.findFirstOrThrow({ where: { order_id: x.orderId } })
      return redeemTicket({ eventId: x.eventId, user: { id: x.host, role: "organizer" }, credential: { doorCode: t.door_code } })
    }
    expect(await redeem(o)).toEqual({ ok: false, reason: "invalid" })
    expect(await redeem(control)).toMatchObject({ ok: true })
    const missing = (x: typeof o) => missingTicketAtCheckIn({ id: x.eventId, ticketing_mode: "native", organizer_org_id: x.orgId }, x.buyerId)
    expect([await missing(o), await missing(control)]).toEqual([true, false])
  })

  it("a door scan waits for a refund claim in flight, then refuses", async () => {
    const o = await paid()
    const t = await db.tickets.findFirstOrThrow({ where: { order_id: o.orderId } })
    let commit = () => {}
    const committed = new Promise<void>((r) => (commit = r))
    const claim = db.$transaction(
      async (tx) => {
        await tx.ticket_orders.update({ where: { id: o.orderId }, data: { refund_requested_at: new Date(), refund_requested_minor: PRICE, refund_reason: "buyer_request" } })
        await committed
      },
      { timeout: 20_000 }
    )
    await new Promise((r) => setTimeout(r, 100))
    const scan = redeemTicket({ eventId: o.eventId, user: { id: o.host, role: "organizer" }, credential: { doorCode: t.door_code } })
    await new Promise((r) => setTimeout(r, 300))
    commit()
    await claim
    expect(await scan).toEqual({ ok: false, reason: "invalid" })
  })
})

describe("the host never learns who asked", () => {
  it("says Buyer in the Refunds panel and no person in the organization's audit log", async () => {
    const o = await paid()
    await db.user.update({ where: { id: o.buyerId }, data: { name: "Zephyrine Buyer" } })
    await ask(o.orderId, o.buyerId)

    expect((await ticketsSummary(o.eventId)).refunds).toEqual([expect.objectContaining({ by: "Buyer", amountMinor: PRICE })])
    const sales = await salesPage(await actorFor({ id: o.host, role: "organizer" }), o.eventId, { page: 1 })

    session = { user: { id: o.host, role: "organizer", signedInAt: Date.now() } }
    const log = await getAuditLog({})
    const entry = log.entries.find((e) => e.action === "ticket_order.buyer_refund" && e.resourceId === o.orderId)
    expect(entry).toMatchObject({ actor: { id: "buyer", name: "Buyer", email: "" }, details: { amountMinor: PRICE, chargedFeesMinor: 0 } })
    for (const shown of [sales, log, await ticketsSummary(o.eventId)]) {
      expect(JSON.stringify(shown)).not.toContain("Zephyrine")
      expect(JSON.stringify(shown)).not.toContain(o.buyerId)
    }
    // Control: the organizer's own refund names the member.
    const other = await paid()
    await refundOrder(other.orderId, { id: other.host, role: "organizer" }, "organizer")
    expect((await ticketsSummary(other.eventId)).refunds[0].by).toContain("Test")
  })
})
