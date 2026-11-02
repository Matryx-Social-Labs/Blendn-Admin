import { randomInt } from "node:crypto"

import { DOOR_CODE_ALPHABET, issueTickets, redeemTicket, ticketQrPayload, verifyTicketQr, type IssuedTicket } from "@/lib/tickets"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

// The real generator, with a seam to force a collision in one test.
jest.mock("node:crypto", () => {
  const actual = jest.requireActual<typeof import("node:crypto")>("node:crypto")
  return { ...actual, randomInt: jest.fn((max: number) => actual.randomInt(max)) }
})

/**
 * Tickets at the door (SCRUM-1010, security H5, database 6): codes nobody
 * misreads, a QR that is signed and stored nowhere, a ticket only for a paid
 * order, and one redemption however many scanners try.
 */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []

let previousFlag: string | undefined
let previousKey: string | undefined
beforeAll(() => {
  previousFlag = process.env.TICKETING
  previousKey = process.env.TICKET_QR_KEY
  process.env.TICKETING = "true"
  // The suite's own key, never a deployment's.
  process.env.TICKET_QR_KEY = "itest-ticket-qr-key-0123456789abcdef-tickets"
})
afterAll(async () => {
  process.env.TICKETING = previousFlag
  process.env.TICKET_QR_KEY = previousKey
  if (events.length) {
    await db.tickets.deleteMany({ where: { event_id: { in: events } } })
    await db.ticket_order_lines.deleteMany({ where: { event_id: { in: events } } })
    await db.ticket_orders.deleteMany({ where: { event_id: { in: events } } })
    await db.ticket_types.deleteMany({ where: { event_id: { in: events } } })
  }
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

const draw = randomInt as unknown as jest.Mock<number, [number]>
const realDraw = draw.getMockImplementation()!
afterEach(() => draw.mockImplementation(realDraw))

/** An organisation's event with one paid order of `seats` tickets, and a door person who operates it. */
async function paidOrder(seats = 1, status: "paid" | "pending" = "paid") {
  const org = await db.organisations.create({ data: { display_name: testId("tk-org"), kind: "company", status: "verified" }, select: { id: true } })
  orgs.push(org.id)
  const host = await makeUser(testId("tk-host"), "organizer")
  const buyer = await makeUser(testId("tk-buyer"))
  users.push(host, buyer)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "staff" } })
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })
  const type = await db.ticket_types.create({ data: { event_id: eventId, name: "General", price_minor: 49_900, quantity: 50 }, select: { id: true } })
  const paid = status === "paid" ? { provider_payment_ref: `pay_${testId("tk")}`, paid_at: new Date() } : {}
  const order = await db.ticket_orders.create({
    data: {
      event_id: eventId,
      buyer_id: buyer,
      status,
      currency: "INR",
      subtotal_minor: 49_900 * seats,
      service_fee_minor: 0,
      service_fee_tax_minor: 0,
      processing_fee_minor: 0,
      total_minor: 49_900 * seats,
      fees_absorbed: false,
      fee_breakdown: {},
      hold_expires_at: new Date(Date.now() + 600_000),
      ...paid,
      lines: { create: [{ ticket_type_id: type.id, quantity: seats, unit_price_minor: 49_900 }] },
    },
    select: { id: true },
  })
  return { eventId, orderId: order.id, typeId: type.id, buyer, host }
}

const issue = (orderId: string) => db.$transaction((tx) => issueTickets(tx, orderId))
const door = (host: string) => ({ id: host, role: "organizer" as const })

describe("issuing", () => {
  it("one ticket per seat, a six-character code from the alphabet, and a QR derived again on demand, stored nowhere", async () => {
    const { orderId, buyer } = await paidOrder(3)

    const issued = await issue(orderId)

    expect(issued).toHaveLength(3)
    const rows = await db.tickets.findMany({ where: { order_id: orderId } })
    expect(rows).toHaveLength(3)
    for (const t of issued) {
      expect(t.doorCode).toMatch(new RegExp(`^[${DOOR_CODE_ALPHABET}]{6}$`))
      const row = rows.find((r) => r.id === t.ticketId)!
      expect(row).toMatchObject({ holder_id: buyer, door_code: t.doorCode })
      // A reinstall asks again and gets the same QR; nothing in the row is its MAC.
      expect(ticketQrPayload(t.ticketId)).toBe(t.qrPayload)
      expect(verifyTicketQr(t.qrPayload)).toBe(t.ticketId)
      expect(JSON.stringify(row)).not.toContain(t.qrPayload.split(".")[1])
    }
    const columns = await db.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'tickets'`
    expect(columns.map((c) => c.column_name).filter((c) => c.startsWith("qr"))).toEqual([])
  })

  it("draws again when a code is already taken at the event, keyed on that index", async () => {
    const { orderId } = await paidOrder(2)
    // Twelve draws of the first symbol: the first ticket is 222222, and so is the second's first try.
    let calls = 0
    draw.mockImplementation(() => (calls++ < 12 ? 0 : 1))

    const issued = await issue(orderId)

    expect(issued.map((t) => t.doorCode)).toEqual(["222222", "333333"])
    expect(calls).toBe(18)
    expect(await db.tickets.count({ where: { order_id: orderId } })).toBe(2)
  })

  it("gives up after eight taken codes in a row: a broken generator, not bad luck", async () => {
    const { orderId } = await paidOrder(2)
    draw.mockImplementation(() => 0)
    await expect(issue(orderId)).rejects.toMatchObject({ code: "P2002" })
    expect(await db.tickets.count({ where: { order_id: orderId } })).toBe(0)
  })

  it("refuses a ticket for an order that is not paid (trigger tickets_order_must_be_paid)", async () => {
    const { orderId } = await paidOrder(1, "pending")
    await expect(issue(orderId)).rejects.toThrow(/tickets_order_must_be_paid/)
    expect(await db.tickets.count({ where: { order_id: orderId } })).toBe(0)
  })
})

describe("redeeming", () => {
  async function issuedTicket(): Promise<IssuedTicket & Awaited<ReturnType<typeof paidOrder>>> {
    const order = await paidOrder(1)
    const [ticket] = await issue(order.orderId)
    return { ...order, ...ticket }
  }

  it("by door code, once; the second scan says when it was let in", async () => {
    const t = await issuedTicket()

    const first = await redeemTicket({ eventId: t.eventId, user: door(t.host), credential: { doorCode: t.doorCode.toLowerCase() } })
    const second = await redeemTicket({ eventId: t.eventId, user: door(t.host), credential: { doorCode: t.doorCode } })

    expect(first).toMatchObject({ ok: true, ticketId: t.ticketId })
    expect(second).toEqual({ ok: false, reason: "already_redeemed", redeemedAt: first.ok && first.redeemedAt })
    expect(await db.tickets.findUniqueOrThrow({ where: { id: t.ticketId } })).toMatchObject({ redeemed_by: t.host })
  })

  it("by QR, and never by one whose MAC is wrong or signed with another key", async () => {
    const t = await issuedTicket()
    const forged = `${t.ticketId}.${"A".repeat(43)}`
    const key = process.env.TICKET_QR_KEY
    process.env.TICKET_QR_KEY = "another-environments-key-0123456789abcdef"
    const otherKey = ticketQrPayload(t.ticketId)
    process.env.TICKET_QR_KEY = key

    expect(await redeemTicket({ eventId: t.eventId, user: door(t.host), credential: { qr: forged } })).toEqual({ ok: false, reason: "invalid" })
    expect(await redeemTicket({ eventId: t.eventId, user: door(t.host), credential: { qr: otherKey } })).toEqual({ ok: false, reason: "invalid" })
    expect((await redeemTicket({ eventId: t.eventId, user: door(t.host), credential: { qr: t.qrPayload } })).ok).toBe(true)
  })

  it("ten scanners at once: exactly one lets it in", async () => {
    const t = await issuedTicket()
    const results = await Promise.all(Array.from({ length: 10 }, () => redeemTicket({ eventId: t.eventId, user: door(t.host), credential: { doorCode: t.doorCode } })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.reason === "already_redeemed")).toHaveLength(9)
  })

  it("only someone who operates the event", async () => {
    const t = await issuedTicket()
    const stranger = await makeUser(testId("tk-stranger"), "organizer")
    users.push(stranger)
    expect(await redeemTicket({ eventId: t.eventId, user: door(stranger), credential: { doorCode: t.doorCode } })).toEqual({ ok: false, reason: "not_authorized" })
    expect(await redeemTicket({ eventId: t.eventId, user: door(t.buyer), credential: { doorCode: t.doorCode } })).toEqual({ ok: false, reason: "not_authorized" })
    expect((await db.tickets.findUniqueOrThrow({ where: { id: t.ticketId } })).redeemed_at).toBeNull()
  })

  it("not a ticket from another event, nor one whose order was refunded", async () => {
    const t = await issuedTicket()
    const elsewhere = await issuedTicket()
    expect(await redeemTicket({ eventId: t.eventId, user: door(t.host), credential: { qr: elsewhere.qrPayload } })).toEqual({ ok: false, reason: "invalid" })

    await db.ticket_orders.update({ where: { id: t.orderId }, data: { status: "refunded" } })
    expect(await redeemTicket({ eventId: t.eventId, user: door(t.host), credential: { doorCode: t.doorCode } })).toEqual({ ok: false, reason: "invalid" })
  })

  it.each([{ doorCode: "" }, { doorCode: "ABC" }, { qr: "nope" }, { qr: "a.b.c" }])("refuses %p as invalid", async (credential) => {
    const t = await issuedTicket()
    expect(await redeemTicket({ eventId: t.eventId, user: door(t.host), credential })).toEqual({ ok: false, reason: "invalid" })
  })
})
