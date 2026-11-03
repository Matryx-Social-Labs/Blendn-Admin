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

describe("holds under concurrency (security review 4)", () => {
  const until = (end: Date) => end.getTime() + PAYOUT_HOLD_AFTER_EVENT_MS
  afterEach(() => {
    fake.delay = () => 0
  })

  it("two postponements at once end at the higher hold, at Razorpay and in the database", async () => {
    const { eventId, host, orderId, payout } = await paidAndTransferred()
    const higher = new Date(Date.now() + 40 * DAY)
    const lower = new Date(Date.now() + 20 * DAY)
    // The lower one's Razorpay call is slow, so without serialising it lands last and lowers the hold.
    fake.delay = (method, _path, body) =>
      method !== "PATCH" ? 0 : (body as { on_hold_until: number }).on_hold_until === Math.floor(until(lower) / 1000) ? 400 : 200
    session = { user: { id: host, role: "organizer" } }
    const [a, b] = await Promise.all([
      patch(eventId, { end_time: higher.toISOString() }),
      new Promise((r) => setTimeout(r, 50)).then(() => patch(eventId, { end_time: lower.toISOString() })),
    ])
    session = null
    expect([a.status, b.status]).toEqual([200, 200])
    const row = await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })
    expect(row.on_hold_until.getTime()).toBe(until(higher))
    expect(fake.transfer(payout.provider_transfer_ref!)!.on_hold_until).toBe(Math.floor(until(higher) / 1000))
  })

  it("a postponement racing the transfer leaves the database and Razorpay at the same hold, the new floor", async () => {
    const world = await ticketedEvent(w, [{ quantity: 10 }])
    const start = new Date(Date.now() + 5 * DAY)
    await db.events.update({ where: { id: world.eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) } })
    const b = await buyer(w)
    fake.failOnce.add("POST /payments/") // the transfer fails at settle: the payout waits, pending
    const { orderRef, orderId } = await heldOrder(fake, world.eventId, b, [{ ticketTypeId: world.typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })).status).toBe("pending")
    // The transfer is slow to make; the postponement arrives while it is in flight.
    fake.delay = (method, path) => (method === "POST" && /\/transfers$/.test(path) ? 400 : 0)
    const newEnd = new Date(Date.now() + 25 * DAY)
    session = { user: { id: world.host, role: "organizer" } }
    const [, res] = await Promise.all([
      createPayoutTransfer(orderId),
      new Promise((r) => setTimeout(r, 100)).then(() => patch(world.eventId, { end_time: newEnd.toISOString() })),
    ])
    session = null
    expect(res.status).toBe(200)
    const row = await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })
    expect(row.status).toBe("on_hold")
    expect(row.on_hold_until.getTime()).toBe(until(newEnd))
    expect(fake.transfer(row.provider_transfer_ref!)!.on_hold_until).toBe(Math.floor(until(newEnd) / 1000))
  })

  it("moving the start later is checked with the end: a start past the end is refused, both later postpone", async () => {
    const { eventId, host, orderId, start } = await paidAndTransferred()
    session = { user: { id: host, role: "organizer" } }
    // Start alone moved past the unchanged end: refused, not a silent postponement.
    const alone = await patch(eventId, { start_time: new Date(start.getTime() + 10 * DAY).toISOString() })
    expect(alone.status).toBe(400)
    // Start and end both later: a postponement, the hold follows.
    const newStart = new Date(start.getTime() + 10 * DAY)
    const newEnd = new Date(newStart.getTime() + 2 * 3_600_000)
    const both = await patch(eventId, { start_time: newStart.toISOString(), end_time: newEnd.toISOString() })
    session = null
    expect(both.status).toBe(200)
    expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })).on_hold_until.getTime()).toBe(until(newEnd))
  })

  it("refuses a start at or after the end, and a time that is not a time, writing nothing", async () => {
    const { eventId, host, start } = await paidAndTransferred()
    const before = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { start_time: true, end_time: true } })
    session = { user: { id: host, role: "organizer" } }
    const same = await patch(eventId, { start_time: start.toISOString(), end_time: start.toISOString() })
    const backwards = await patch(eventId, { start_time: new Date(start.getTime() + 3_600_000).toISOString(), end_time: start.toISOString() })
    const garbage = await patch(eventId, { end_time: "not a date" })
    session = null
    expect([same.status, backwards.status, garbage.status]).toEqual([400, 400, 400])
    const after = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { start_time: true, end_time: true } })
    expect(after).toEqual(before)
  })
})

describe("the transfer's hold backstop", () => {
  it("raises a transfer that already exists at Razorpay (a retry) to the floor, and records that hold", async () => {
    const world = await ticketedEvent(w, [{ quantity: 10 }])
    const b = await buyer(w)
    const { orderRef, orderId } = await heldOrder(fake, world.eventId, b, [{ ticketTypeId: world.typeIds[0], quantity: 1 }])
    await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))
    await settled()
    const made = await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })
    // Razorpay made the transfer with a short hold, and our row never heard: pending, no ref (the retry case).
    fake.transfer(made.provider_transfer_ref!)!.on_hold_until = Math.floor((Date.now() + DAY) / 1000)
    const end = new Date(Date.now() + 30 * DAY)
    await db.events.update({ where: { id: world.eventId }, data: { end_time: end } })
    await db.ticket_payouts.update({ where: { order_id: orderId }, data: { status: "pending", provider_transfer_ref: null } })
    expect(await createPayoutTransfer(orderId)).toBe(made.provider_transfer_ref)
    const floor = end.getTime() + PAYOUT_HOLD_AFTER_EVENT_MS
    expect(fake.transfer(made.provider_transfer_ref!)!.on_hold_until).toBe(Math.floor(floor / 1000))
    expect((await db.ticket_payouts.findUniqueOrThrow({ where: { order_id: orderId } })).on_hold_until.getTime()).toBe(floor)
  })

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
