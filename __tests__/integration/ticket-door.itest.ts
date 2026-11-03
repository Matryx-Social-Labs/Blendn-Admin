import { resetMemoryStore } from "@/lib/rate-limit-store"
import { admitAtDoor, doorCount, DOOR_PER_ACTOR_PER_MINUTE, DOOR_PER_EVENT_PER_MINUTE } from "@/lib/ticket-door"
import { ticketQrPayload } from "@/lib/tickets"

import { closeDb, db, makeUser, testId } from "./helpers"
import { buyer, capturedDelivery, deliver, fakeRazorpay, heldOrder, newWorld, settled, teardown, ticketEnv, ticketedEvent, type FakeRazorpay } from "./ticket-world"

/**
 * The door (SCRUM-1014): the sixth character or a scan lets a ticket in, in
 * one step; a code used once is refused with when; the door says a code and a
 * type, never a person; attempts are limited per operator and per event.
 */

const w = newWorld()
let restore: () => void
let fake: FakeRazorpay

beforeAll(() => {
  restore = ticketEnv()
  // The limiter's in-process store, never Redis, in this suite.
  delete process.env.REDIS_URL
  fake = fakeRazorpay()
})
beforeEach(() => resetMemoryStore())
afterAll(async () => {
  jest.restoreAllMocks()
  await teardown(w)
  restore()
  await closeDb()
})

/** A paid order of `quantity` tickets through the real webhook, and its tickets. */
async function paidTickets(eventId: string, typeId: string, quantity: number) {
  const b = await buyer(w)
  const { orderRef, orderId } = await heldOrder(fake, eventId, b, [{ ticketTypeId: typeId, quantity }])
  expect((await deliver(capturedDelivery("payment.captured", fake.capture(orderRef)))).status).toBe(200)
  await settled()
  const tickets = await db.tickets.findMany({ where: { order_id: orderId }, orderBy: { id: "asc" }, select: { id: true, door_code: true } })
  return { buyerId: b, orderId, tickets }
}

describe("letting a ticket in", () => {
  it("admits a typed code in one step, and refuses it the second time with when it was used", async () => {
    const { eventId, host, typeIds } = await ticketedEvent(w, [{ quantity: 10, price: 99_900 }])
    const { tickets, buyerId } = await paidTickets(eventId, typeIds[0], 2)
    const user = { id: host, role: "organizer" as const }

    const first = await admitAtDoor(eventId, user, { code: tickets[0].door_code.toLowerCase() })
    expect(first).toMatchObject({ kind: "let_in", code: tickets[0].door_code, typeName: "Tier 0", of: 2 })
    // One write: the row is redeemed, by this operator.
    const row = await db.tickets.findUniqueOrThrow({ where: { id: tickets[0].id } })
    expect(row.redeemed_by).toBe(host)
    expect(row.redeemed_at).not.toBeNull()

    const again = await admitAtDoor(eventId, user, { code: tickets[0].door_code })
    expect(again).toMatchObject({ kind: "used", code: tickets[0].door_code, typeName: "Tier 0" })
    expect(again.kind === "used" && again.at.getTime()).toBe(row.redeemed_at!.getTime())

    // Never a person: no buyer id, name or email anywhere in what the door is told.
    const said = JSON.stringify([first, again])
    expect(said).not.toContain(buyerId)
    expect(said).not.toMatch(/@itest\.invalid|Test tix-buyer/)
  })

  it("admits a scanned QR, and refuses a forged one and a code from another event", async () => {
    const { eventId, host, typeIds } = await ticketedEvent(w, [{ quantity: 10 }])
    const { tickets } = await paidTickets(eventId, typeIds[0], 1)
    const other = await ticketedEvent(w, [{ quantity: 10 }])
    const elsewhere = await paidTickets(other.eventId, other.typeIds[0], 1)
    const user = { id: host, role: "organizer" as const }

    const forged = `${tickets[0].id}.${"A".repeat(43)}`
    expect(await admitAtDoor(eventId, user, { qr: forged })).toMatchObject({ kind: "invalid" })
    expect(await admitAtDoor(eventId, user, { qr: ticketQrPayload(elsewhere.tickets[0].id) })).toMatchObject({ kind: "invalid" })
    expect(await admitAtDoor(eventId, user, { code: elsewhere.tickets[0].door_code })).toMatchObject({ kind: "invalid" })

    expect(await admitAtDoor(eventId, user, { qr: ticketQrPayload(tickets[0].id) })).toMatchObject({ kind: "let_in", code: tickets[0].door_code })
    expect(await doorCount(eventId)).toEqual({ inside: 1, of: 1 })
  })

  it("refuses a refunded ticket as not valid", async () => {
    const { eventId, host, typeIds } = await ticketedEvent(w, [{ quantity: 10 }])
    const { tickets, orderId } = await paidTickets(eventId, typeIds[0], 1)
    await db.ticket_orders.update({ where: { id: orderId }, data: { status: "refunded", refunded_minor: 1, refunded_at: new Date(), provider_refund_ref: `rfnd_${testId("r").slice(-12)}` } })
    expect(await admitAtDoor(eventId, { id: host, role: "organizer" }, { code: tickets[0].door_code })).toMatchObject({ kind: "invalid" })
  })

  it("is nobody's door but the event's operators", async () => {
    const { eventId, typeIds } = await ticketedEvent(w, [{ quantity: 10 }])
    const { tickets } = await paidTickets(eventId, typeIds[0], 1)
    const stranger = await makeUser(testId("tix-door-stranger"), "organizer")
    w.users.push(stranger)
    expect(await admitAtDoor(eventId, { id: stranger, role: "organizer" }, { code: tickets[0].door_code })).toMatchObject({ kind: "not_authorized" })
    expect((await db.tickets.findUniqueOrThrow({ where: { id: tickets[0].id } })).redeemed_at).toBeNull()
  })
})

describe("the door's limits", () => {
  it(`waits after ${DOOR_PER_ACTOR_PER_MINUTE} attempts a minute from one operator, and the next operator still works`, async () => {
    const { eventId, host, orgId, typeIds } = await ticketedEvent(w, [{ quantity: 10 }])
    const { tickets } = await paidTickets(eventId, typeIds[0], 1)
    const user = { id: host, role: "organizer" as const }
    for (let i = 0; i < DOOR_PER_ACTOR_PER_MINUTE; i++) {
      expect((await admitAtDoor(eventId, user, { code: "ZZZZZZ" })).kind).toBe("invalid")
    }
    const limited = await admitAtDoor(eventId, user, { code: tickets[0].door_code })
    expect(limited).toMatchObject({ kind: "wait" })
    expect(limited.kind === "wait" && limited.retryAfter).toBeGreaterThan(0)
    // The limit refused before the write: the real ticket is still unused.
    expect((await db.tickets.findUniqueOrThrow({ where: { id: tickets[0].id } })).redeemed_at).toBeNull()

    const colleague = await makeUser(testId("tix-door-colleague"), "organizer")
    w.users.push(colleague)
    await db.organisation_members.create({ data: { org_id: orgId, user_id: colleague, role: "staff" } })
    expect(await admitAtDoor(eventId, { id: colleague, role: "organizer" }, { code: tickets[0].door_code })).toMatchObject({ kind: "let_in" })
  })

  it(`caps the whole event at ${DOOR_PER_EVENT_PER_MINUTE} attempts a minute, however many operators`, async () => {
    const { eventId, orgId } = await ticketedEvent(w, [{ quantity: 10 }])
    const staff: string[] = []
    const operators = Math.ceil(DOOR_PER_EVENT_PER_MINUTE / DOOR_PER_ACTOR_PER_MINUTE) + 1
    for (let i = 0; i < operators; i++) {
      const s = await makeUser(testId("tix-door-op"), "organizer")
      w.users.push(s)
      await db.organisation_members.create({ data: { org_id: orgId, user_id: s, role: "staff" } })
      staff.push(s)
    }
    let attempts = 0
    let waited = 0
    for (const s of staff) {
      for (let i = 0; i < DOOR_PER_ACTOR_PER_MINUTE; i++) {
        const r = await admitAtDoor(eventId, { id: s, role: "organizer" }, { code: "ZZZZZZ" })
        attempts++
        if (r.kind === "wait") waited++
      }
    }
    expect(attempts).toBeGreaterThan(DOOR_PER_EVENT_PER_MINUTE)
    expect(waited).toBe(attempts - DOOR_PER_EVENT_PER_MINUTE)
  }, 60_000)
})
