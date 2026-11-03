import { createPayoutTransfer } from "@/lib/ticket-settle"
import { PAYOUT_HOLD_AFTER_EVENT_MS } from "@/lib/ticket-payments"

import { closeDb, db } from "./helpers"
import { buyer, capturedDelivery, deliver, fakeRazorpay, heldOrder, newWorld, settled, teardown, ticketEnv, ticketedEvent, type FakeRazorpay } from "./ticket-world"

/**
 * A postponed ticketed event keeps the organizer's money held until after the
 * real night (SCRUM-1014, security review 3): moving the end later extends every
 * unreleased payout's hold at Razorpay first and in the database in the edit's
 * own transaction; a Razorpay failure refuses the edit; nothing ever shortens a
 * hold; and a transfer is never sent with a hold before the event's end + 3 days.
 */

let session: { user: { id: string; role: "organizer" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => session }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

const w = newWorld()
let restore: () => void
let fake: FakeRazorpay
const DAY = 86_400_000

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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = () => require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")

async function paidAndTransferred() {
  const world = await ticketedEvent(w, [{ quantity: 10 }])
  // Not started: an upcoming night, so its times may move.
  const start = new Date(Date.now() + 5 * DAY)
  await db.events.update({ where: { id: world.eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) } })
  const b = await buyer(w)
  const { orderRef, orderId } = await heldOrder(fake, world.eventId, b, [{ ticketTypeId: world.typeIds[0], quantity: 1 }])
  await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
  await settled()
  const payout = await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })
  return { ...world, orderId, payout, start }
}

const patch = (eventId: string, body: Record<string, unknown>) =>
  route().PATCH(new Request(`http://localhost/api/events/${eventId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: eventId }),
  })

const holdCalls = () => fake.calls.filter((c) => c.method === "PATCH" && /^\/transfers\//.test(c.path))

describe("postponing a ticketed event", () => {
  it("extends the payout hold at Razorpay and in the database to the new end + 3 days", async () => {
    const { eventId, host, orderId, payout } = await paidAndTransferred()
    expect(payout.status).toBe("on_hold")
    const newEnd = new Date(Date.now() + 20 * DAY)
    session = { user: { id: host, role: "organizer" } }
    fake.calls.length = 0
    const res = await patch(eventId, { start_time: new Date(newEnd.getTime() - 3_600_000).toISOString(), end_time: newEnd.toISOString() })
    session = null
    expect(res.status).toBe(200)
    const until = newEnd.getTime() + PAYOUT_HOLD_AFTER_EVENT_MS
    expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })).on_hold_until.getTime()).toBe(until)
    expect(holdCalls()).toEqual([{ method: "PATCH", path: `/transfers/${payout.provider_transfer_ref}`, body: { on_hold: true, on_hold_until: Math.floor(until / 1000) } }])
  })

  it("refuses the edit and writes nothing when Razorpay cannot extend the hold", async () => {
    const { eventId, host, orderId, payout } = await paidAndTransferred()
    const before = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { end_time: true } })
    fake.failOnce.add("PATCH /transfers/")
    session = { user: { id: host, role: "organizer" } }
    const res = await patch(eventId, { end_time: new Date(Date.now() + 20 * DAY).toISOString() })
    session = null
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ errorCode: "payout_hold_not_extended" })
    expect((await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { end_time: true } })).end_time.getTime()).toBe(before.end_time.getTime())
    expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })).on_hold_until.getTime()).toBe(payout.on_hold_until.getTime())
  })

  it("never shortens a hold when the event moves earlier", async () => {
    const { eventId, host, orderId, payout, start } = await paidAndTransferred()
    session = { user: { id: host, role: "organizer" } }
    fake.calls.length = 0
    const earlier = new Date(start.getTime() - 2 * DAY)
    const res = await patch(eventId, { start_time: earlier.toISOString(), end_time: new Date(earlier.getTime() + 3_600_000).toISOString() })
    session = null
    expect(res.status).toBe(200)
    expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })).on_hold_until.getTime()).toBe(payout.on_hold_until.getTime())
    expect(holdCalls()).toEqual([])
  })
})

describe("the transfer's hold backstop", () => {
  it("never sends Razorpay a hold earlier than the event's current end + 3 days", async () => {
    const world = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    fake.failOnce.add("POST /payments/") // the transfer fails at settle, leaving the payout pending
    const { orderRef, orderId } = await heldOrder(fake, world.eventId, b, [{ ticketTypeId: world.typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    // A stale recorded hold, as if the event moved later between the payment and the transfer.
    const end = new Date(Date.now() + 30 * DAY)
    await db.events.update({ where: { id: world.eventId }, data: { end_time: end } })
    await db.ticket_payouts.update({ where: { order_id: orderId }, data: { status: "pending", provider_transfer_ref: null, on_hold_until: new Date(Date.now() + DAY) } })
    fake.transfers.clear()
    fake.calls.length = 0
    await createPayoutTransfer(orderId)
    const sent = fake.calls.find((c) => c.method === "POST" && /\/transfers$/.test(c.path))
    expect((sent?.body as { transfers: Array<{ on_hold_until: number }> }).transfers[0].on_hold_until).toBe(Math.floor((end.getTime() + PAYOUT_HOLD_AFTER_EVENT_MS) / 1000))
    expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })).on_hold_until.getTime()).toBe(end.getTime() + PAYOUT_HOLD_AFTER_EVENT_MS)
  })
})
