import { randomUUID } from "crypto"

// The Sales panel's server action, called as a crafted request would call it: the session is the only input it trusts.
let session: { user: { id: string; role: "organizer" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => session }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { actorFor } from "@/lib/org-membership"
import { attendeeLabel } from "@/lib/pseudonym"
import { refundOrder } from "@/lib/ticket-refunds"
import { SALES_PAGE_SIZE, salesPage, ticketsSummary } from "@/lib/ticket-sales"

import { closeDb, db, makeUser, testId } from "./helpers"
import { buyer, capturedDelivery, deliver, fakeRazorpay, heldOrder, newWorld, settled, teardown, ticketEnv, ticketedEvent, type FakeRazorpay } from "./ticket-world"

/**
 * The Sales panel (SCRUM-1014): paged on the server, 50 at a time, holding up
 * at 2,000 orders; buyers as their attendee label, never a person; a refund
 * goes through `refundOrder` and the row says so.
 */

const w = newWorld()
let restore: () => void
let fake: FakeRazorpay

beforeAll(() => {
  restore = ticketEnv()
  fake = fakeRazorpay()
})
afterAll(async () => {
  jest.restoreAllMocks()
  await teardown(w)
  restore()
  await closeDb()
})

const ORDERS = 2_000

/** `count` paid orders of one ticket each, straight into the tables: the webhook's rows, without 2,000 webhooks. */
async function bulkPaid(eventId: string, typeId: string, buyers: string[], count: number) {
  const base = Date.now() - count * 1000
  const rows = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    event_id: eventId,
    buyer_id: buyers[i % buyers.length],
    status: "paid" as const,
    currency: "INR",
    subtotal_minor: 49_900,
    service_fee_minor: 0,
    service_fee_tax_minor: 0,
    processing_fee_minor: 0,
    total_minor: 49_900,
    fees_absorbed: true,
    fee_breakdown: {},
    provider_payment_ref: `pay_bulk${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    paid_at: new Date(base + i * 1000),
    hold_expires_at: new Date(base + i * 1000),
    created_at: new Date(base + i * 1000),
  }))
  await db.ticket_orders.createMany({ data: rows })
  await db.ticket_order_lines.createMany({ data: rows.map((r) => ({ order_id: r.id, ticket_type_id: typeId, event_id: eventId, quantity: 1, unit_price_minor: 49_900 })) })
  await db.ticket_types.update({ where: { id: typeId }, data: { sold: { increment: count } } })
  return rows.map((r) => r.id)
}

describe("sales at 2,000 orders", () => {
  let eventId: string
  let host: string
  let orgId: string
  let ids: string[]
  let buyers: string[]

  beforeAll(async () => {
    const world = await ticketedEvent(w, [{ quantity: ORDERS + 10, price: 49_900 }, { quantity: 10, price: 99_900 }])
    ;({ eventId, host, orgId } = world)
    buyers = []
    for (let i = 0; i < 5; i++) {
      const b = await makeUser(testId("tix-bulk"))
      w.users.push(b)
      buyers.push(b)
    }
    ids = await bulkPaid(eventId, world.typeIds[0], buyers, ORDERS)
  }, 60_000)

  it("pages 50 at a time, newest first, with the total", async () => {
    const actor = await actorFor({ id: host, role: "organizer" })
    const started = Date.now()
    const first = await salesPage(actor, eventId, { page: 1 })
    const elapsed = Date.now() - started
    expect(first).not.toBeNull()
    expect(first!.rows).toHaveLength(SALES_PAGE_SIZE)
    expect(first!.total).toBe(ORDERS)
    expect(first!.pages).toBe(ORDERS / SALES_PAGE_SIZE)
    expect(first!.rows[0].id).toBe(ids[ORDERS - 1])
    // Generous: a page is two indexed reads, not a scan of 2,000 rows through the app.
    expect(elapsed).toBeLessThan(2_000)

    const last = await salesPage(actor, eventId, { page: 40 })
    expect(last!.rows).toHaveLength(SALES_PAGE_SIZE)
    expect(last!.rows.at(-1)!.id).toBe(ids[0])
    // Past the end reads the last page, not an empty one.
    expect((await salesPage(actor, eventId, { page: 999 }))!.page).toBe(40)
    expect((await salesPage(actor, eventId, { page: -3 }))!.page).toBe(1)
  })

  it("shows a buyer as the Attendees label, and carries no buyer id, name or email", async () => {
    const actor = await actorFor({ id: host, role: "organizer" })
    const page = await salesPage(actor, eventId, { page: 1 })
    const row = page!.rows[0]
    const buyerId = buyers[(ORDERS - 1) % buyers.length]
    expect(row.label).toBe(attendeeLabel(buyerId, orgId))
    expect(row.ref).toBe(row.id.slice(0, 8).toUpperCase())
    const serialised = JSON.stringify(page)
    for (const b of buyers) expect(serialised).not.toContain(b)
    expect(serialised).not.toMatch(/@itest\.invalid|Test tix-bulk/)
  })

  it("finds an order by its reference and a buyer by their label", async () => {
    const actor = await actorFor({ id: host, role: "organizer" })
    const byRef = await salesPage(actor, eventId, { page: 1, q: ids[7].slice(0, 8) })
    expect(byRef!.rows.map((r) => r.id)).toContain(ids[7])
    expect(byRef!.total).toBeLessThan(5)

    const label = attendeeLabel(buyers[2], orgId)
    const byLabel = await salesPage(actor, eventId, { page: 1, q: label })
    expect(byLabel!.total).toBe(ORDERS / buyers.length)
    expect(byLabel!.rows.every((r) => r.label === label)).toBe(true)

    // Control: a label from another organization's scope finds nobody here.
    expect((await salesPage(actor, eventId, { page: 1, q: attendeeLabel(buyers[2], randomUUID()) }))!.total).toBe(0)
  })

  it("filters by ticket type", async () => {
    const actor = await actorFor({ id: host, role: "organizer" })
    const types = await db.ticket_types.findMany({ where: { event_id: eventId }, orderBy: { sort: "asc" } })
    expect((await salesPage(actor, eventId, { page: 1, typeId: types[0].id }))!.total).toBe(ORDERS)
    expect((await salesPage(actor, eventId, { page: 1, typeId: types[1].id }))!.total).toBe(0)
  })

  it("is nobody else's to read", async () => {
    const stranger = await makeUser(testId("tix-sales-stranger"), "organizer")
    w.users.push(stranger)
    expect(await salesPage(await actorFor({ id: stranger, role: "organizer" }), eventId, { page: 1 })).toBeNull()
  })

  it("adds the money up: sold, refunded, the organizer's share and when it is released", async () => {
    const s = await ticketsSummary(eventId)
    expect(s.soldTickets).toBe(ORDERS)
    expect(s.grossMinor).toBe(ORDERS * 49_900)
    expect(s.refundedMinor).toBe(0)
    expect(s.payoutMinor).toBe(ORDERS * 49_900)
    expect(s.capacity).toBe(ORDERS + 20)
    const event = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { end_time: true } })
    expect(s.releaseAt.getTime()).toBe(event.end_time.getTime() + 3 * 86_400_000)
  })
})

describe("a refund from the Sales panel", () => {
  it("claims the refund through refundOrder, and the row then reads refunded", async () => {
    const { eventId, host, typeIds, orgId } = await ticketedEvent(w, [{ quantity: 10, price: 149_900 }])
    const b = await buyer(w)
    const { orderRef, orderId } = await heldOrder(fake, eventId, b, [{ ticketTypeId: typeIds[0], quantity: 2 }])
    const payment = fake.capture(orderRef)
    expect((await deliver(capturedDelivery("payment.captured", payment))).status).toBe(200)
    await settled()

    const actor = await actorFor({ id: host, role: "organizer" })
    const before = await salesPage(actor, eventId, { page: 1 })
    expect(before!.rows[0]).toMatchObject({ id: orderId, status: "paid", refundable: true, quantity: 2, ticketPriceMinor: 299_800 })

    // A stranger's attempt reads as not found and claims nothing.
    const stranger = await makeUser(testId("tix-refund-stranger"), "organizer")
    w.users.push(stranger)
    expect(await refundOrder(orderId, { id: stranger, role: "organizer" }, "organizer")).toEqual({ ok: false, reason: "not_found" })
    expect((await db.ticket_orders.findUniqueOrThrow({ where: { id: orderId } })).refund_requested_at).toBeNull()

    expect(await refundOrder(orderId, { id: host, role: "organizer" }, "organizer")).toEqual({ ok: true })
    const after = await salesPage(actor, eventId, { page: 1 })
    expect(after!.rows[0]).toMatchObject({ id: orderId, refundable: false })
    expect(["refunding", "refunded"]).toContain(after!.rows[0].status)

    const s = await ticketsSummary(eventId)
    expect(s.refunds).toEqual([expect.objectContaining({ ref: orderId.slice(0, 8).toUpperCase(), by: expect.stringContaining("Test") })])
    const audit = await db.audit_logs.findFirst({ where: { action: "ticket_order.refund", resource_id: orderId } })
    expect(audit).toMatchObject({ user_id: host, org_id: orgId })
  })

  it("refuses an organizer refund once the payout is released, in refundOrder and through a crafted action call, writing nothing", async () => {
    const { eventId, host, typeIds } = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const { orderRef, orderId } = await heldOrder(fake, eventId, b, [{ ticketTypeId: typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    // Control: before release the same organizer may refund another order of the same event.
    const b2 = await buyer(w)
    const second = await heldOrder(fake, eventId, b2, [{ ticketTypeId: typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(second.orderRef)))
    await settled()
    expect(await refundOrder(second.orderId, { id: host, role: "organizer" }, "organizer")).toEqual({ ok: true })

    // The release job released the organizer's share.
    await db.ticket_payouts.update({ where: { order_id: orderId }, data: { status: "released", released_at: new Date() } })
    const auditsBefore = await db.audit_logs.count({ where: { action: "ticket_order.refund", resource_id: orderId } })
    expect(await refundOrder(orderId, { id: host, role: "organizer" }, "organizer")).toEqual({ ok: false, reason: "payout_released" })

    session = { user: { id: host, role: "organizer" } }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { refundSale } = require("@/app/dashboard/events/[id]/tickets/actions") as typeof import("@/app/dashboard/events/[id]/tickets/actions")
    expect(await refundSale(eventId, orderId)).toMatchObject({ ok: false })
    session = null

    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: orderId } })
    expect(order).toMatchObject({ status: "paid", refund_requested_at: null, refund_requested_minor: null })
    expect(await db.audit_logs.count({ where: { action: "ticket_order.refund", resource_id: orderId } })).toBe(auditsBefore)
  })

  it("trusts the payout's status, not the event's end time: moving end_time later does not reopen a released refund", async () => {
    const { eventId, host, typeIds, orgId } = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const { orderRef, orderId } = await heldOrder(fake, eventId, b, [{ ticketTypeId: typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    await db.ticket_payouts.update({ where: { order_id: orderId }, data: { status: "released", released_at: new Date() } })
    // The end time pushed a month out, as an edit that slipped past the route would.
    await db.events.update({ where: { id: eventId }, data: { end_time: new Date(Date.now() + 30 * 86_400_000) } })

    expect(await refundOrder(orderId, { id: host, role: "organizer" }, "organizer")).toEqual({ ok: false, reason: "payout_released" })
    expect((await db.ticket_orders.findUniqueOrThrow({ where: { id: orderId } })).refund_requested_at).toBeNull()
    const actor = await actorFor({ id: host, role: "organizer" })
    expect((await salesPage(actor, eventId, { page: 1 }))!.rows.find((r) => r.id === orderId)).toMatchObject({ refundable: false })
    expect(orgId).toBeTruthy()
  })

  it("refuses moving a started event's times once it has paid tickets, and allows it before", async () => {
    const { eventId, host, typeIds } = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const { orderRef, orderId } = await heldOrder(fake, eventId, b, [{ ticketTypeId: typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const route = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
    const patch = (body: Record<string, unknown>) =>
      route.PATCH(new Request(`http://localhost/api/events/${eventId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ id: eventId }),
      })
    session = { user: { id: host, role: "organizer" } }
    try {
      // Not started yet: an edit is allowed.
      const start = new Date(Date.now() + 3 * 86_400_000)
      await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 2 * 3_600_000) } })
      const earlier = new Date(start.getTime() - 86_400_000)
      const allowed = await patch({ start_time: earlier.toISOString(), end_time: new Date(earlier.getTime() + 3_600_000).toISOString() })
      expect(allowed.status).toBe(200)
      expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })).status).toBe("on_hold")

      // Started: the times are fixed.
      const started = new Date(Date.now() - 3_600_000)
      await db.events.update({ where: { id: eventId }, data: { start_time: started, end_time: new Date(Date.now() + 3_600_000) } })
      const refused = await patch({ end_time: new Date(Date.now() + 30 * 86_400_000).toISOString() })
      expect(refused.status).toBe(409)
      const row = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { end_time: true } })
      expect(row.end_time.getTime()).toBeLessThan(Date.now() + 2 * 3_600_000)

      // Control: a started event with no paid tickets keeps today's editing.
      await db.ticket_orders.updateMany({ where: { event_id: eventId }, data: { status: "refunded", refunded_minor: 1, refunded_at: new Date(), provider_refund_ref: `rfnd_${randomUUID().slice(0, 12)}` } })
      expect((await patch({ end_time: new Date(Date.now() + 2 * 3_600_000).toISOString() })).status).toBe(200)
    } finally {
      session = null
    }
  })

  it("offers no refund once the payout is released", async () => {
    const { eventId, host, typeIds } = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const { orderRef, orderId } = await heldOrder(fake, eventId, b, [{ ticketTypeId: typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    // The event ended more than three days ago, and the release job released the payout.
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - 6 * 86_400_000), end_time: new Date(Date.now() - 5 * 86_400_000) } })
    await db.ticket_payouts.update({ where: { order_id: orderId }, data: { status: "released", released_at: new Date() } })
    const page = await salesPage(await actorFor({ id: host, role: "organizer" }), eventId, { page: 1 })
    expect(page!.rows[0]).toMatchObject({ status: "paid", refundable: false })
    expect((await ticketsSummary(eventId)).released).toBe(true)
  })
})
