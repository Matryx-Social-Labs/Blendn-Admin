import { releaseDuePayouts, RELEASING_RETRY_MS } from "@/lib/payout-release"
import { holdFloor } from "@/lib/ticket-payments"
import { reserveTickets } from "@/lib/ticket-holds"
import { saveTicketType } from "@/lib/ticket-types"
import { cancelEventRefundAll, refundOrder } from "@/lib/ticket-refunds"

import { closeDb, db } from "./helpers"
import { buyer, capturedDelivery, deliver, fakeRazorpay, heldOrder, newWorld, PAYOUT_HOLD_MS, settled, teardown, ticketEnv, ticketedEvent, type FakeRazorpay } from "./ticket-world"

/**
 * We are the only releaser of an organizer's payout (SCRUM-1014, security
 * review 5). Every Route transfer is held at Razorpay indefinitely; the release
 * job releases a payout once its event's current holdFloor (the later of start
 * and end, + 3 days) has passed, through `releasing` to `released`; an
 * organizer refund is refused once a payout is `releasing` or `released`.
 */

let session: { user: { id: string; role: "organizer" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => session }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

const w = newWorld()
let restore: () => void
let fake: FakeRazorpay
const DAY = 86_400_000
const HOUR = 3_600_000

beforeAll(() => {
  restore = ticketEnv()
  fake = fakeRazorpay()
})
afterEach(() => {
  fake.delay = () => 0
})
afterAll(async () => {
  jest.restoreAllMocks()
  await teardown(w)
  restore()
  await closeDb()
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = () => require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
const patch = (eventId: string, body: Record<string, unknown>) =>
  route().PATCH(new Request(`http://localhost/api/events/${eventId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: eventId }),
  })

/** An upcoming event (starts in 5 days) with `orders` paid orders, each transferred to the linked account. */
async function sold(orders = 1) {
  const world = await ticketedEvent(w, [{ quantity: 20 }])
  const start = new Date(Date.now() + 5 * DAY)
  await db.events.update({ where: { id: world.eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * HOUR) } })
  const orderIds: string[] = []
  for (let i = 0; i < orders; i++) {
    const b = await buyer(w)
    const { orderRef, orderId } = await heldOrder(fake, world.eventId, b, [{ ticketTypeId: world.typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    orderIds.push(orderId)
  }
  return { ...world, orderIds, start }
}

const payoutOf = (orderId: string) => db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })
const floorOf = async (eventId: string) => holdFloor(await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { start_time: true, end_time: true } }))
const releaseCalls = () => fake.calls.filter((c) => c.method === "PATCH" && /^\/transfers\//.test(c.path))

describe("transfers are held until we release them", () => {
  it("creates every transfer with on_hold true and no on_hold_until", async () => {
    const { orderIds } = await sold(2)
    // The fake keeps each transfer as Razorpay was asked to make it (heldOrder clears the call log, so read its state).
    for (const id of orderIds) {
      const t = fake.transfer((await payoutOf(id)).provider_transfer_ref!)!
      expect(t.on_hold).toBe(true)
      expect(t).not.toHaveProperty("on_hold_until")
    }
    for (const id of orderIds) expect((await payoutOf(id)).status).toBe("on_hold")
  })
})

describe("the release job", () => {
  it("releases a payout once its event's floor has passed, and not before", async () => {
    const { eventId, orderIds } = await sold()
    const floor = await floorOf(eventId)
    fake.calls.length = 0
    await releaseDuePayouts(new Date(floor.getTime() - 60_000))
    expect((await payoutOf(orderIds[0])).status).toBe("on_hold")
    expect(releaseCalls()).toEqual([])

    await releaseDuePayouts(new Date(floor.getTime() + 60_000))
    const p = await payoutOf(orderIds[0])
    expect(p.status).toBe("released")
    expect(p.released_at).not.toBeNull()
    expect(fake.transfer(p.provider_transfer_ref!)!.on_hold).toBe(false)
  })

  it("a postponement before release delays it, and makes no Razorpay call", async () => {
    const { eventId, host, orderIds, start } = await sold()
    const oldFloor = await floorOf(eventId)
    fake.calls.length = 0
    session = { user: { id: host, role: "organizer" } }
    const later = new Date(start.getTime() + 20 * DAY)
    const res = await patch(eventId, { start_time: later.toISOString(), end_time: new Date(later.getTime() + 3 * HOUR).toISOString() })
    session = null
    expect(res.status).toBe(200)
    expect(fake.calls.filter((c) => /^\/transfers/.test(c.path))).toEqual([])

    // Past the old floor, before the new: still held.
    await releaseDuePayouts(new Date(oldFloor.getTime() + DAY))
    expect((await payoutOf(orderIds[0])).status).toBe("on_hold")
    expect(releaseCalls()).toEqual([])
    await releaseDuePayouts(new Date((await floorOf(eventId)).getTime() + 60_000))
    expect((await payoutOf(orderIds[0])).status).toBe("released")
  })

  it("is idempotent across a crash between Razorpay's release and our write", async () => {
    const { eventId, orderIds } = await sold()
    const after = new Date((await floorOf(eventId)).getTime() + 60_000)
    await releaseDuePayouts(after)
    // The crash: Razorpay released it, our row still says releasing, claimed long ago.
    await db.ticket_payouts.update({ where: { order_id: orderIds[0] }, data: { status: "releasing", releasing_at: new Date(Date.now() - RELEASING_RETRY_MS - 60_000), released_at: null } })
    const result = await releaseDuePayouts(after)
    expect(result).toMatchObject({ released: 1, failed: 0 })
    const p = await payoutOf(orderIds[0])
    expect(p.status).toBe("released")
    expect(fake.transfer(p.provider_transfer_ref!)!.on_hold).toBe(false)
  })

  it("retries a claim stuck in releasing for over 30 minutes, and leaves a fresh one alone", async () => {
    const { eventId, orderIds } = await sold(2)
    const after = new Date((await floorOf(eventId)).getTime() + 60_000)
    await db.ticket_payouts.update({ where: { order_id: orderIds[0] }, data: { status: "releasing", releasing_at: new Date(Date.now() - RELEASING_RETRY_MS - 60_000) } })
    await db.ticket_payouts.update({ where: { order_id: orderIds[1] }, data: { status: "releasing", releasing_at: new Date() } })
    fake.calls.length = 0
    await releaseDuePayouts(after)
    expect((await payoutOf(orderIds[0])).status).toBe("released")
    // Fresh: another worker may be mid-call; not touched.
    expect((await payoutOf(orderIds[1])).status).toBe("releasing")
    expect(releaseCalls()).toHaveLength(1)
  })

  it("leaves a payout whose order is being refunded, and a cancelled event's", async () => {
    const { eventId, host, orderIds } = await sold(2)
    const after = new Date((await floorOf(eventId)).getTime() + 60_000)
    // Claimed, and Razorpay's refund failed: the payout is still on hold, its order is being refunded.
    fake.failOnce.add("POST /payments/")
    expect(await refundOrder(orderIds[0], { id: host, role: "organizer" }, "organizer")).toEqual({ ok: false, reason: "retrying" })
    expect((await payoutOf(orderIds[0])).status).toBe("on_hold")
    await releaseDuePayouts(after)
    expect((await payoutOf(orderIds[0])).status).toBe("on_hold")
    expect((await payoutOf(orderIds[1])).status).toBe("released")

    const other = await sold()
    await db.events.update({ where: { id: other.eventId }, data: { status: "cancelled" } })
    await releaseDuePayouts(new Date((await floorOf(other.eventId)).getTime() + 60_000))
    expect((await payoutOf(other.orderIds[0])).status).toBe("on_hold")
  })
})

describe("the refund gate is the payout's status", () => {
  it("refuses an organizer refund while releasing and once released, writing nothing", async () => {
    const { host, orderIds } = await sold(2)
    await db.ticket_payouts.update({ where: { order_id: orderIds[0] }, data: { status: "releasing", releasing_at: new Date() } })
    await db.ticket_payouts.update({ where: { order_id: orderIds[1] }, data: { status: "released", released_at: new Date() } })
    for (const id of orderIds) {
      expect(await refundOrder(id, { id: host, role: "organizer" }, "organizer")).toEqual({ ok: false, reason: "payout_released" })
      expect((await db.ticket_orders.findUniqueOrThrow({ where: { id } })).refund_requested_at).toBeNull()
    }
  })

  it("is unaffected by the event's times: an event long over with its payout still held refunds", async () => {
    const { eventId, host, orderIds } = await sold()
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - 10 * DAY), end_time: new Date(Date.now() - 9 * DAY) } })
    expect(await refundOrder(orderIds[0], { id: host, role: "organizer" }, "organizer")).toEqual({ ok: true })
  })

  it("a refund waits for a release claim in flight, then is refused", async () => {
    const { host, orderIds } = await sold()
    // The release job's claim, not yet committed: the payout row is locked and says releasing.
    let commit = () => {}
    const committed = new Promise<void>((r) => (commit = r))
    const claim = db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE ticket_payouts SET status = 'releasing', releasing_at = now() WHERE order_id = ${orderIds[0]}::uuid`
      await committed
    }, { timeout: 20_000 })
    await new Promise((r) => setTimeout(r, 100))
    const refund = refundOrder(orderIds[0], { id: host, role: "organizer" }, "organizer")
    await new Promise((r) => setTimeout(r, 300))
    commit()
    await claim
    expect(await refund).toEqual({ ok: false, reason: "payout_released" })
    expect((await db.ticket_orders.findUniqueOrThrow({ where: { id: orderIds[0] } })).refund_requested_at).toBeNull()
  })

  it("lets exactly one of a refund and a release win, every time, on real Postgres", async () => {
    const { eventId, host, orderIds } = await sold(6)
    const after = new Date((await floorOf(eventId)).getTime() + 60_000)
    // Slow Razorpay on both sides, so the two really overlap.
    fake.delay = (method, path) => (method === "PATCH" && /^\/transfers\//.test(path)) || /\/refund$/.test(path) ? 150 : 0
    const results = await Promise.all([releaseDuePayouts(after), ...orderIds.map((id) => refundOrder(id, { id: host, role: "organizer" }, "organizer"))])
    const refunds = results.slice(1) as Array<{ ok: boolean; reason?: string }>
    for (const [i, id] of orderIds.entries()) {
      const p = await payoutOf(id)
      const o = await db.ticket_orders.findUniqueOrThrow({ where: { id } })
      const released = p.status === "released" || p.status === "releasing"
      const refunded = o.refund_requested_at !== null
      expect({ id, released, refunded }).toEqual({ id, released: !refunded, refunded: !released })
      expect(refunds[i].ok).toBe(refunded)
      if (released) expect(refunds[i]).toEqual({ ok: false, reason: "payout_released" })
    }
  })
})

describe("a premature release (security review 6)", () => {
  it("records each payout's release floor at payment, and the database refuses lowering it", async () => {
    const { eventId, orderIds } = await sold()
    const p = await payoutOf(orderIds[0])
    expect(p.release_floor.getTime()).toBe((await floorOf(eventId)).getTime())
    await expect(db.ticket_payouts.update({ where: { order_id: orderIds[0] }, data: { release_floor: new Date(Date.now() - DAY) } })).rejects.toThrow()
    // Raising is allowed.
    await db.ticket_payouts.update({ where: { order_id: orderIds[0] }, data: { release_floor: new Date(p.release_floor.getTime() + DAY) } })
  })

  it("the recorded floor alone holds the money when the event's times are moved into the past behind the edit's back", async () => {
    const { eventId, orderIds } = await sold()
    const recorded = (await payoutOf(orderIds[0])).release_floor
    // As if the edit route's guard were not there: the times written straight to the row, a week in the past.
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - 8 * DAY), end_time: new Date(Date.now() - 7 * DAY) } })
    fake.calls.length = 0
    await releaseDuePayouts(new Date())
    expect((await payoutOf(orderIds[0])).status).toBe("on_hold")
    expect(releaseCalls()).toEqual([])
    await releaseDuePayouts(new Date(recorded.getTime() + 60_000))
    expect((await payoutOf(orderIds[0])).status).toBe("released")
  })

  it("refuses moving a ticketed event's times earlier, or into the past", async () => {
    const { eventId, host, start } = await sold()
    const before = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { start_time: true, end_time: true } })
    session = { user: { id: host, role: "organizer" } }
    const earlier = new Date(start.getTime() - DAY)
    const sooner = await patch(eventId, { start_time: earlier.toISOString(), end_time: new Date(earlier.getTime() + 3 * HOUR).toISOString() })
    const past = await patch(eventId, { start_time: new Date(Date.now() - 2 * DAY).toISOString(), end_time: new Date(Date.now() - DAY).toISOString() })
    const endSooner = await patch(eventId, { end_time: new Date(start.getTime() + HOUR).toISOString() })
    session = null
    expect([sooner.status, past.status, endSooner.status]).toEqual([409, 409, 409])
    expect(await sooner.json()).toMatchObject({ errorCode: "times_only_later" })
    expect(await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { start_time: true, end_time: true } })).toEqual(before)
  })
})

describe("refunds and releases share one lock order (security review 6)", () => {
  it("cancel-all racing the release job: every order is refunded with its payout held, or released with the refund flagged, never both", async () => {
    const { eventId, host, orderIds } = await sold(6)
    const after = new Date((await floorOf(eventId)).getTime() + 60_000)
    fake.delay = (method, path) => (method === "PATCH" && /^\/transfers\//.test(path) ? 120 : 0)
    const release = releaseDuePayouts(after)
    await new Promise((r) => setTimeout(r, 200))
    await db.events.update({ where: { id: eventId }, data: { status: "cancelled" } })
    const cancel = await cancelEventRefundAll(eventId, { id: host, role: "organizer" })
    await release
    expect(cancel.ok).toBe(true)
    let refunded = 0
    let flagged = 0
    for (const id of orderIds) {
      const p = await payoutOf(id)
      const o = await db.ticket_orders.findUniqueOrThrow({ where: { id } })
      const gone = p.status === "releasing" || p.status === "released"
      const claimed = o.refund_requested_at !== null
      expect({ id, both: gone && claimed, neither: !gone && !claimed }).toEqual({ id, both: false, neither: false })
      if (claimed) refunded++
      if (gone) {
        flagged++
        expect(await db.audit_logs.count({ where: { action: "ticket_order.cancel_refund_manual", resource_id: id } })).toBe(1)
      }
    }
    expect(refunded + flagged).toBe(orderIds.length)
  })
})

describe("an edit racing a reserve, and a payment after the end (security review 7)", () => {
  it("never leaves a held or paid order on an event moved earlier: the edit or the order is refused", async () => {
    for (let round = 0; round < 6; round++) {
      const world = await ticketedEvent(w, [{ quantity: 20 }])
      const start = new Date(Date.now() + 5 * DAY)
      await db.events.update({ where: { id: world.eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * HOUR) } })
      const b = await buyer(w)
      const past = new Date(Date.now() - 2 * DAY)
      session = { user: { id: world.host, role: "organizer" } }
      const [edit, held] = await Promise.all([
        patch(world.eventId, { start_time: past.toISOString(), end_time: new Date(past.getTime() + HOUR).toISOString() }),
        reserveTickets({ eventId: world.eventId, buyerId: b, lines: [{ ticketTypeId: world.typeIds[0], quantity: 1 }] }),
      ])
      session = null
      const moved = edit.status === 200
      expect({ round, both: moved && held.ok }).toEqual({ round, both: false })
      const e = await db.events.findUniqueOrThrow({ where: { id: world.eventId }, select: { start_time: true } })
      const orders = await db.ticket_orders.count({ where: { event_id: world.eventId, status: { in: ["pending", "paid"] } } })
      expect({ round, earlierWithOrders: e.start_time < start && orders > 0 }).toEqual({ round, earlierWithOrders: false })
    }
  }, 60_000)

  it("does not deadlock: reserves, type edits and time edits on one event at once all finish", async () => {
    const world = await ticketedEvent(w, [{ quantity: 50 }])
    const start = new Date(Date.now() + 5 * DAY)
    await db.events.update({ where: { id: world.eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * HOUR) } })
    const buyers = await Promise.all(Array.from({ length: 6 }, () => buyer(w)))
    const host = { id: world.host, role: "organizer" as const }
    session = { user: host }
    const results = await Promise.allSettled([
      ...buyers.map((b) => reserveTickets({ eventId: world.eventId, buyerId: b, lines: [{ ticketTypeId: world.typeIds[0], quantity: 1 }] })),
      ...[1, 2, 3].map((i) => saveTicketType(world.eventId, host, { id: world.typeIds[0], name: `Tier ${i}`, price: "499", quantity: "50", maxPerOrder: "10", salesStart: "", salesEnd: "", onSale: "on" })),
      ...[1, 2].map((i) => patch(world.eventId, { start_time: new Date(start.getTime() + i * DAY).toISOString(), end_time: new Date(start.getTime() + i * DAY + 3 * HOUR).toISOString() })),
    ])
    session = null
    const errors = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))
    expect(errors).toEqual([])
    const reserves = results.slice(0, buyers.length).map((r) => (r as PromiseFulfilledResult<{ ok: boolean; reason?: string }>).value)
    expect(reserves.filter((r) => !r.ok && r.reason !== "busy")).toEqual([])
  }, 60_000)

  it("refunds a payment for an event that has already ended, as late_payment, and owes no payout", async () => {
    const world = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const { orderRef, orderId } = await heldOrder(fake, world.eventId, b, [{ ticketTypeId: world.typeIds[0], quantity: 1 }])
    // The event ended while the buyer was paying (times written behind the route's back).
    await db.events.update({ where: { id: world.eventId }, data: { start_time: new Date(Date.now() - 2 * DAY), end_time: new Date(Date.now() - DAY) } })
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    const o = await db.ticket_orders.findUniqueOrThrow({ where: { id: orderId } })
    expect(o.status).not.toBe("paid")
    expect(o.refund_reason).toBe("late_payment")
    expect(await db.ticket_payouts.count({ where: { order_id: orderId } })).toBe(0)
  })

  it("records a release floor at least three days after the payment, whatever the event's times say", async () => {
    const world = await ticketedEvent(w, [{ quantity: 10 }])
    // Started an hour ago, ends in an hour: its own floor is three days after the end.
    await db.events.update({ where: { id: world.eventId }, data: { start_time: new Date(Date.now() - HOUR), end_time: new Date(Date.now() + HOUR) } })
    const b = await buyer(w)
    const before = Date.now()
    const { orderRef, orderId } = await heldOrder(fake, world.eventId, b, [{ ticketTypeId: world.typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    expect((await payoutOf(orderId)).release_floor.getTime()).toBeGreaterThanOrEqual(before + PAYOUT_HOLD_MS)
  })
})

describe("event times", () => {
  it("refuses a start at or after the end, and a non-date, writing nothing", async () => {
    const { eventId, host, start } = await sold()
    const before = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { start_time: true, end_time: true } })
    session = { user: { id: host, role: "organizer" } }
    const same = await patch(eventId, { start_time: start.toISOString(), end_time: start.toISOString() })
    const pastEnd = await patch(eventId, { start_time: new Date(start.getTime() + 10 * DAY).toISOString() })
    const garbage = await patch(eventId, { end_time: "not a date" })
    session = null
    expect([same.status, pastEnd.status, garbage.status]).toEqual([400, 400, 400])
    expect(await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { start_time: true, end_time: true } })).toEqual(before)
  })
})
