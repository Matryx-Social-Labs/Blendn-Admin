import { cancelBuyerHolds, releaseExpiredHolds } from "@/lib/ticket-holds"
import { PAYOUT_HOLD_AFTER_EVENT_MS } from "@/lib/ticket-payments"
import { reconcileTicketPayments } from "@/lib/ticket-reconcile"
import { cancelEventRefundAll, refundOrder } from "@/lib/ticket-refunds"
import { createPayoutTransfer, executeRefund } from "@/lib/ticket-settle"

import { closeDb, db, makeUser, testId } from "./helpers"
import {
  buyer,
  capturedDelivery,
  deliver,
  fakeRazorpay,
  heldOrder,
  lapse,
  LINKED_ACCOUNT,
  newWorld,
  orderRow,
  refundDelivery,
  settled,
  teardown,
  ticketedEvent,
  ticketEnv,
  typeRow,
  type FakeRazorpay,
} from "./ticket-world"

/**
 * Ticket payments end to end against real Postgres (SCRUM-1011): the signed
 * webhook through its route, fulfilment, late payment both ways, the payout's
 * Route transfer, refunds, and the reconcile job. Razorpay is the fake in
 * ticket-world.ts (no test keys on this machine); every case reads the rows
 * back, and the Razorpay calls the fake recorded.
 */

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

async function boughtOrder(quantity = 2, typeSpec = { quantity: 10 }) {
  const ev = await ticketedEvent(w, [typeSpec])
  const b = await buyer(w)
  const held = await heldOrder(rzp, ev.eventId, b, [{ ticketTypeId: ev.typeIds[0], quantity }])
  return { ...ev, buyerId: b, ...held }
}

describe("a captured payment", () => {
  it("issues the tickets, sells the seats, writes the RSVP and owes the payout, in one go", async () => {
    const o = await boughtOrder(2)
    const payment = rzp.capture(o.orderRef)

    const res = await deliver(capturedDelivery("payment.captured", payment))
    await settled()

    expect(res).toEqual({ status: 200, body: { ok: true, duplicate: false, applied: true } })
    expect(await orderRow(o.orderId)).toMatchObject({ status: "paid", provider_payment_ref: payment.id, _count: { tickets: 2 } })
    expect(await typeRow(o.typeIds[0])).toEqual({ sold: 2, held: 0, quantity: 10 })
    const rsvp = await db.event_rsvps.findUnique({ where: { event_id_user_id: { event_id: o.eventId, user_id: o.buyerId } } })
    expect(rsvp?.status).toBe("going")
    const tickets = await db.tickets.findMany({ where: { order_id: o.orderId } })
    expect(tickets.every((t) => t.holder_id === o.buyerId)).toBe(true)
  })

  it("transfers the organizer's share to the linked account, held until three days after the event ends", async () => {
    const o = await boughtOrder(2)
    const payment = rzp.capture(o.orderRef)
    await deliver(capturedDelivery("payment.captured", payment))
    await settled()

    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: o.orderId } })
    const share = order.total_minor - order.service_fee_minor - order.service_fee_tax_minor - order.processing_fee_minor
    expect(share).toBe(2 * 49_900)
    const transfers = rzp.transfers.get(payment.id) ?? []
    expect(transfers).toHaveLength(1)
    expect(transfers[0]).toMatchObject({ recipient: LINKED_ACCOUNT, amount: share, currency: "INR", on_hold_until: Math.floor((o.endTime.getTime() + PAYOUT_HOLD_AFTER_EVENT_MS) / 1000) })
    const payout = await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: o.orderId } })
    expect(payout).toMatchObject({ status: "on_hold", provider_transfer_ref: transfers[0].id, amount_minor: share, org_id: o.orgId })
  })

  it("is fulfilled once when the same delivery arrives twice", async () => {
    const o = await boughtOrder(2)
    const payment = rzp.capture(o.orderRef)
    const body = capturedDelivery("payment.captured", payment)

    const first = await deliver(body, "itest_tix_twice")
    const second = await deliver(body, "itest_tix_twice")
    await settled()

    expect(first.body).toMatchObject({ duplicate: false, applied: true })
    expect(second.body).toMatchObject({ duplicate: true, applied: false })
    expect(await db.tickets.count({ where: { order_id: o.orderId } })).toBe(2)
    expect(await typeRow(o.typeIds[0])).toMatchObject({ sold: 2, held: 0 })
    expect(rzp.transfers.get(payment.id)).toHaveLength(1)
  })

  it("is fulfilled once when payment.captured and order.paid both arrive, at the same time", async () => {
    const o = await boughtOrder(3)
    const payment = rzp.capture(o.orderRef)

    const results = await Promise.all([deliver(capturedDelivery("payment.captured", payment)), deliver(capturedDelivery("order.paid", payment))])
    await settled()

    expect(results.map((r) => r.body.applied).sort()).toEqual([false, true])
    expect(await db.tickets.count({ where: { order_id: o.orderId } })).toBe(3)
    expect(await typeRow(o.typeIds[0])).toMatchObject({ sold: 3, held: 0 })
    expect(await db.ticket_payouts.count({ where: { order_id: o.orderId } })).toBe(1)
  })

  it("tells the buyer: a bell row for the event, the push's record", async () => {
    const o = await boughtOrder(1)
    await deliver(capturedDelivery("payment.captured", rzp.capture(o.orderRef)))
    await settled()
    const bell = await db.notifications.findMany({ where: { user_id: o.buyerId } })
    expect(bell).toEqual([expect.objectContaining({ kind: "event_update", data: expect.objectContaining({ eventId: o.eventId, orderId: o.orderId }) })])
  })

  it("owes the share with fees absorbed as the price less the fees", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }], { absorbed: true })
    const held = await heldOrder(rzp, ev.eventId, await buyer(w), [{ ticketTypeId: ev.typeIds[0], quantity: 1 }])
    const payment = rzp.capture(held.orderRef)
    await deliver(capturedDelivery("payment.captured", payment))
    await settled()
    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: held.orderId } })
    expect(order.total_minor).toBe(49_900)
    expect(rzp.transfers.get(payment.id)![0].amount).toBe(49_900 - order.service_fee_minor - order.service_fee_tax_minor - order.processing_fee_minor)
  })

  it.each([
    ["has no linked account", { account: null }],
    ["has an account no longer active at Razorpay", { accountStatus: "pending" as const }],
  ])("records the payout as owed to nobody when the organisation %s, and transfers nothing", async (_label, opts) => {
    const ev = await ticketedEvent(w, [{ quantity: 10 }], opts)
    const held = await heldOrder(rzp, ev.eventId, await buyer(w), [{ ticketTypeId: ev.typeIds[0], quantity: 1 }])
    const payment = rzp.capture(held.orderRef)
    await deliver(capturedDelivery("payment.captured", payment))
    await settled()
    expect((await orderRow(held.orderId)).status).toBe("paid")
    expect(await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: held.orderId } })).toMatchObject({ status: "no_account", linked_account_ref: null })
    expect(rzp.transfers.get(payment.id)).toBeUndefined()
  })

  it.each([
    ["one paisa short", (p: { amount: number }) => ({ amount: p.amount - 1 })],
    ["one paisa over", (p: { amount: number }) => ({ amount: p.amount + 1 })],
    ["another currency", () => ({ currency: "USD" })],
  ])("is refused when %s: no tickets, no seats sold, the refusal recorded", async (_label, change) => {
    const o = await boughtOrder(2)
    const payment = { ...rzp.capture(o.orderRef) }
    const eventId = `itest_tix_${testId("mismatch")}`

    const res = await deliver(capturedDelivery("payment.captured", { ...payment, ...change(payment) }), eventId)

    expect(res.body).toMatchObject({ applied: false, refused: "amount_mismatch" })
    expect(await orderRow(o.orderId)).toMatchObject({ status: "pending", provider_payment_ref: null, _count: { tickets: 0 } })
    expect(await typeRow(o.typeIds[0])).toMatchObject({ sold: 0, held: 2 })
    expect((await db.payment_events.findFirstOrThrow({ where: { provider_event_id: eventId } })).error).toBe("amount_mismatch")
  })

  it("refuses a forged signature before anything is read", async () => {
    const o = await boughtOrder(1)
    const payment = rzp.capture(o.orderRef)
    const res = await deliver(capturedDelivery("payment.captured", payment), undefined, "whsec_not_the_secret_0123456789abcdef")
    expect(res.status).toBe(401)
    expect((await orderRow(o.orderId)).status).toBe("pending")
  })

  it("leaves a billing order to billing: an unknown order reference is not a ticket's", async () => {
    const res = await deliver(capturedDelivery("payment.captured", { id: "pay_unrelated01", order_id: "order_not_a_ticket", amount: 100, currency: "INR", created_at: 1 }))
    expect(res.body).toMatchObject({ applied: false })
    expect(res.body.refused).toBeUndefined()
  })
})

describe("paid after the hold ran out", () => {
  it("is re-seated straight to sold when the seats are still there", async () => {
    const o = await boughtOrder(2)
    await lapse(o.orderId)
    expect((await releaseExpiredHolds()).released).toBeGreaterThanOrEqual(1)
    expect(await typeRow(o.typeIds[0])).toMatchObject({ sold: 0, held: 0 })
    const payment = rzp.capture(o.orderRef)

    await deliver(capturedDelivery("payment.captured", payment))
    await settled()

    expect(await orderRow(o.orderId)).toMatchObject({ status: "paid", _count: { tickets: 2 } })
    expect(await typeRow(o.typeIds[0])).toEqual({ sold: 2, held: 0, quantity: 10 })
  })

  it("is refunded in full, automatically, when the seats went to someone else; no tickets oversell the room", async () => {
    const o = await boughtOrder(2, { quantity: 2 })
    await lapse(o.orderId)
    await releaseExpiredHolds()
    const rival = await buyer(w)
    const theirs = await heldOrder(rzp, o.eventId, rival, [{ ticketTypeId: o.typeIds[0], quantity: 2 }])
    await deliver(capturedDelivery("payment.captured", rzp.capture(theirs.orderRef)))
    const payment = rzp.capture(o.orderRef)

    const res = await deliver(capturedDelivery("payment.captured", payment))
    await settled()

    expect(res.body).toMatchObject({ applied: true })
    expect(rzp.refunds.get(payment.id)).toEqual([expect.objectContaining({ amount: o.totalMinor })])
    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", refunded_minor: o.totalMinor, refund_reason: "late_payment", _count: { tickets: 0 } })
    expect(await typeRow(o.typeIds[0])).toEqual({ sold: 2, held: 0, quantity: 2 })
    expect(await db.ticket_payouts.count({ where: { order_id: o.orderId } })).toBe(0)
  })

  it("is refunded when the buyer deleted the account while it was held", async () => {
    const o = await boughtOrder(1)
    expect(await cancelBuyerHolds(o.buyerId)).toBe(1)
    expect(await typeRow(o.typeIds[0])).toMatchObject({ held: 0 })
    expect((await orderRow(o.orderId)).status).toBe("cancelled")
    const payment = rzp.capture(o.orderRef)

    await deliver(capturedDelivery("payment.captured", payment))
    await settled()

    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", refund_reason: "order_cancelled", _count: { tickets: 0 } })
    expect(rzp.refunds.get(payment.id)).toHaveLength(1)
  })
})

describe("paid for an event that is no longer on", () => {
  it("is refunded in full, the hold given back, no tickets", async () => {
    const o = await boughtOrder(2)
    await db.events.update({ where: { id: o.eventId }, data: { status: "cancelled" } })
    const payment = rzp.capture(o.orderRef)

    await deliver(capturedDelivery("payment.captured", payment))
    await settled()

    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", refund_reason: "event_not_on", refunded_minor: o.totalMinor, _count: { tickets: 0 } })
    expect(await typeRow(o.typeIds[0])).toMatchObject({ sold: 0, held: 0 })
  })
})

describe("a late payment is held to every gate a hold is (security review)", () => {
  const yearsAgo = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear() - n, 0, 1))
  type O = Awaited<ReturnType<typeof boughtOrder>>
  const gates: Array<[string, (o: O) => Promise<unknown>]> = [
    ["the buyer's seat cap: paid since, it would pass ten", async (o) => {
      const more = await heldOrder(rzp, o.eventId, o.buyerId, [{ ticketTypeId: o.typeIds[0], quantity: 9 }])
      await deliver(capturedDelivery("payment.captured", rzp.capture(more.orderRef)))
    }],
    ["the type's sale window has closed", (o) => db.ticket_types.update({ where: { id: o.typeIds[0] }, data: { sale_ends_at: new Date(Date.now() - 60_000) } })],
    ["the event has ended", (o) => db.events.update({ where: { id: o.eventId }, data: { end_time: new Date(Date.now() - 60_000) } })],
    ["the event stopped selling here", (o) => db.events.update({ where: { id: o.eventId }, data: { ticketing_mode: "external", external_ticket_url: "https://example.com/t" } })],
    ["the event went private", (o) => db.events.update({ where: { id: o.eventId }, data: { visibility: "private" } })],
    ["the event's minimum age is now above the buyer's", async (o) => {
      await db.events.update({ where: { id: o.eventId }, data: { min_age: 21 } })
      await db.profiles.update({ where: { id: o.buyerId }, data: { date_of_birth: yearsAgo(19) } })
    }],
    ["the buyer was suspended", (o) => db.user.update({ where: { id: o.buyerId }, data: { suspended_at: new Date() } })],
    ["the buyer may no longer take part (setup unfinished)", (o) => db.profiles.update({ where: { id: o.buyerId }, data: { onboarded: false, date_of_birth: null, age: null } })],
  ]

  it.each(gates)("refunded in full when %s, no tickets", async (_label, change) => {
    // Room to spare: every refusal here is the gate's, never capacity's.
    const o = await boughtOrder(2, { quantity: 50 })
    await lapse(o.orderId)
    await releaseExpiredHolds()
    await change(o)
    const payment = rzp.capture(o.orderRef)

    await deliver(capturedDelivery("payment.captured", payment))
    await settled()

    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", refund_reason: "late_payment", refunded_minor: o.totalMinor, _count: { tickets: 0 } })
    expect(rzp.refunds.get(payment.id)).toEqual([expect.objectContaining({ amount: o.totalMinor })])
  })
})

describe("payment racing the sweeper", () => {
  it("waits for the sweeper's lock on the order, then settles what it left: expired, re-seated, never held twice", async () => {
    const o = await boughtOrder(2)
    await lapse(o.orderId)
    const payment = rzp.capture(o.orderRef)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let holding!: () => void
    const held = new Promise<void>((r) => (holding = r))
    // The sweeper's transaction, paused between expiring the order and committing.
    const sweeper = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM ticket_orders WHERE id = ${o.orderId}::uuid FOR UPDATE`
        await tx.$executeRaw`UPDATE ticket_types SET held = held - 2 WHERE id = ${o.typeIds[0]}::uuid`
        await tx.$executeRaw`UPDATE ticket_orders SET status = 'expired' WHERE id = ${o.orderId}::uuid`
        holding()
        await gate
      },
      { timeout: 20_000 }
    )
    await held

    const delivery = deliver(capturedDelivery("payment.captured", payment))
    await new Promise((r) => setTimeout(r, 400))
    release()
    await sweeper
    const res = await delivery
    await settled()

    expect(res.status).toBe(200)
    expect(await orderRow(o.orderId)).toMatchObject({ status: "paid", _count: { tickets: 2 } })
    expect(await typeRow(o.typeIds[0])).toEqual({ sold: 2, held: 0, quantity: 10 })
  })

  it("every payment is seated once and nothing oversells, whichever of the two locks the order first", async () => {
    const ev = await ticketedEvent(w, [{ quantity: 8 }])
    const orders = []
    for (let i = 0; i < 8; i++) orders.push(await heldOrder(rzp, ev.eventId, await buyer(w), [{ ticketTypeId: ev.typeIds[0], quantity: 1 }]))
    for (const o of orders) await lapse(o.orderId)

    await Promise.all([
      ...orders.map((o) => deliver(capturedDelivery("payment.captured", rzp.capture(o.orderRef)))),
      releaseExpiredHolds(),
      releaseExpiredHolds({ limit: 3 }),
    ])
    await settled()

    expect(await typeRow(ev.typeIds[0])).toEqual({ sold: 8, held: 0, quantity: 8 })
    const rows = await db.ticket_orders.findMany({ where: { event_id: ev.eventId }, select: { status: true, _count: { select: { tickets: true } } } })
    expect(rows.map((r) => [r.status, r._count.tickets])).toEqual(Array(8).fill(["paid", 1]))
  })
})

describe("refunds", () => {
  async function paid(quantity = 2) {
    const o = await boughtOrder(quantity)
    const payment = rzp.capture(o.orderRef)
    await deliver(capturedDelivery("payment.captured", payment))
    await settled()
    return { ...o, paymentId: payment.id, transferId: rzp.transfers.get(payment.id)![0].id }
  }
  const host = async (o: { host: string }) => ({ id: o.host, role: "organizer" as const })

  it("an organizer refunds the ticket price, keeps the booking fee, takes the share back and frees the seats", async () => {
    const o = await paid(2)
    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: o.orderId } })

    const result = await refundOrder(o.orderId, await host(o), "Can no longer attend")

    expect(result).toEqual({ ok: true })
    expect(rzp.refunds.get(o.paymentId)).toEqual([expect.objectContaining({ amount: order.subtotal_minor })])
    expect(rzp.reversals).toEqual([{ transfer_id: o.transferId, amount: order.subtotal_minor }])
    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", refunded_minor: order.subtotal_minor, refund_reason: "Can no longer attend" })
    expect(await typeRow(o.typeIds[0])).toMatchObject({ sold: 0, held: 0 })
    expect(await db.event_rsvps.findUnique({ where: { event_id_user_id: { event_id: o.eventId, user_id: o.buyerId } } })).toBeNull()
    expect(await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: o.orderId } })).toMatchObject({ status: "reversed", reversed_minor: order.subtotal_minor, org_debit_minor: 0 })
    expect(await db.audit_logs.count({ where: { action: "ticket_order.refund", resource_id: o.orderId } })).toBe(1)
  })

  it("is refused to someone who cannot edit the event, and to a second click", async () => {
    const o = await paid(1)
    const stranger = await makeUser(testId("tix-stranger"), "organizer")
    w.users.push(stranger)

    expect(await refundOrder(o.orderId, { id: stranger, role: "organizer" }, "x")).toEqual({ ok: false, reason: "not_found" })
    const [a, b] = await Promise.all([refundOrder(o.orderId, await host(o), "once"), refundOrder(o.orderId, await host(o), "twice")])

    expect([a, b].filter((r) => r.ok)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, reason: "already_refunding" })
    expect(rzp.refunds.get(o.paymentId)).toHaveLength(1)
  })

  it("a retry after a crash between Razorpay's refund and our commit refunds nothing twice", async () => {
    const o = await paid(1)
    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: o.orderId } })
    // Razorpay refunded; we never recorded it.
    await db.ticket_orders.update({ where: { id: o.orderId }, data: { refund_requested_at: new Date(), refund_requested_minor: order.subtotal_minor, refund_reason: "crash" } })
    rzp.refunds.set(o.paymentId, [{ id: "rfnd_already0001", payment_id: o.paymentId, amount: order.subtotal_minor, currency: "INR", status: "processed" }])

    expect(await executeRefund(o.orderId)).toBe(true)

    expect(rzp.calls.filter((c) => c.method === "POST" && c.path.endsWith("/refund"))).toHaveLength(0)
    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", provider_refund_ref: "rfnd_already0001" })
  })

  it("Razorpay's refund.processed finishes a refund we asked for and never recorded, and refuses one we never asked for", async () => {
    const o = await paid(1)
    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: o.orderId } })

    const unasked = await deliver(refundDelivery({ id: "rfnd_byhand000001", payment_id: o.paymentId, amount: 100 }))
    expect(unasked.body).toMatchObject({ refused: "unrequested_refund" })
    expect((await orderRow(o.orderId)).status).toBe("paid")

    await db.ticket_orders.update({ where: { id: o.orderId }, data: { refund_requested_at: new Date(), refund_requested_minor: order.subtotal_minor, refund_reason: "asked" } })
    const asked = await deliver(refundDelivery({ id: "rfnd_asked0000001", payment_id: o.paymentId, amount: order.subtotal_minor }))
    await settled()

    expect(asked.body).toMatchObject({ applied: true })
    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", provider_refund_ref: "rfnd_asked0000001" })
    expect(rzp.reversals).toEqual([{ transfer_id: o.transferId, amount: order.subtotal_minor }])
  })

  it("cancelling the event refunds everything, booking fee included, and charges the org the processing", async () => {
    const o = await paid(2)
    const other = await heldOrder(rzp, o.eventId, await buyer(w), [{ ticketTypeId: o.typeIds[0], quantity: 1 }])
    const otherPayment = rzp.capture(other.orderRef)
    await deliver(capturedDelivery("payment.captured", otherPayment))
    await settled()

    expect(await cancelEventRefundAll(o.eventId, await host(o))).toEqual({ ok: false, reason: "event_not_cancelled" })
    await db.events.update({ where: { id: o.eventId }, data: { status: "cancelled" } })
    const result = await cancelEventRefundAll(o.eventId, await host(o))

    expect(result).toEqual({ ok: true, refunded: 2, failed: 0, queued: 0 })
    for (const [orderId, paymentId] of [[o.orderId, o.paymentId], [other.orderId, otherPayment.id]]) {
      const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: orderId } })
      expect(order).toMatchObject({ status: "refunded", refunded_minor: order.total_minor, refund_reason: "event_cancelled" })
      expect(rzp.refunds.get(paymentId)).toEqual([expect.objectContaining({ amount: order.total_minor })])
      expect(await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })).toMatchObject({ status: "reversed", org_debit_minor: order.processing_fee_minor })
    }
  })
})

describe("the reconcile job", () => {
  it("settles a payment whose webhook never came, and makes a transfer that failed", async () => {
    const o = await boughtOrder(2)
    await lapse(o.orderId)
    const payment = rzp.capture(o.orderRef)
    rzp.failOnce.add(`POST /payments/${payment.id}/transfers`)

    const first = await reconcileTicketPayments()
    expect(first.paid).toBe(1)
    expect(await orderRow(o.orderId)).toMatchObject({ status: "paid", provider_payment_ref: payment.id, _count: { tickets: 2 } })
    expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: o.orderId } })).status).toBe("pending")

    await db.ticket_payouts.update({ where: { order_id: o.orderId }, data: { created_at: new Date(Date.now() - 10 * 60_000) } })
    const second = await reconcileTicketPayments()
    expect(second.transferred).toBe(1)
    expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: o.orderId } })).status).toBe("on_hold")
    expect(rzp.transfers.get(payment.id)).toHaveLength(1)
  })

  it("makes a transfer once even when Razorpay made it and our record of it was lost", async () => {
    const o = await boughtOrder(1)
    const payment = rzp.capture(o.orderRef)
    await deliver(capturedDelivery("payment.captured", payment))
    await settled()
    await db.ticket_payouts.update({ where: { order_id: o.orderId }, data: { status: "pending", provider_transfer_ref: null } })

    expect(await createPayoutTransfer(o.orderId)).toBe(rzp.transfers.get(payment.id)![0].id)
    expect(rzp.transfers.get(payment.id)).toHaveLength(1)
  })

  it("retries a refund that failed at Razorpay", async () => {
    const o = await boughtOrder(1, { quantity: 1 })
    await lapse(o.orderId)
    await releaseExpiredHolds()
    const rival = await heldOrder(rzp, o.eventId, await buyer(w), [{ ticketTypeId: o.typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", rzp.capture(rival.orderRef)))
    const payment = rzp.capture(o.orderRef)
    rzp.failOnce.add(`POST /payments/${payment.id}/refund`)

    await deliver(capturedDelivery("payment.captured", payment))
    await settled()
    expect(await orderRow(o.orderId)).toMatchObject({ status: "expired", refund_requested_minor: o.totalMinor })

    await db.ticket_orders.update({ where: { id: o.orderId }, data: { refund_requested_at: new Date(Date.now() - 10 * 60_000) } })
    expect((await reconcileTicketPayments()).refunded).toBe(1)
    expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded", refunded_minor: o.totalMinor })
  })
})
