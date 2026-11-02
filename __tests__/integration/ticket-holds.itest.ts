import { feeScheduleFromMarket, ticketFees, type FeeRule, type MarketFeeRow } from "@/lib/ticket-fees"
import { HOLD_MINUTES, MAX_PENDING_PER_BUYER, MAX_SEATS_PER_BUYER, releaseExpiredHolds, reserveTickets, type ReserveInput } from "@/lib/ticket-holds"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * Ticket holds against the real database (SCRUM-1008).
 *
 * A hold is the one place two buyers race for the same seat. The row lock in
 * `reserveTickets` serialises them; `ticket_types_not_oversold`
 * (`sold + held <= quantity`, migration SQL only) is the last word if the
 * lock were ever skipped. A mocked database proves neither, and a `db push`
 * database has no CHECK at all, so this suite runs on a migrated one.
 */

const users: string[] = []
const events: string[] = []

let previousFlag: string | undefined
beforeAll(() => {
  previousFlag = process.env.TICKETING
  process.env.TICKETING = "true"
})

afterAll(async () => {
  process.env.TICKETING = previousFlag
  if (events.length) {
    await db.ticket_order_lines.deleteMany({ where: { event_id: { in: events } } })
    await db.ticket_orders.deleteMany({ where: { event_id: { in: events } } })
    await db.ticket_types.deleteMany({ where: { event_id: { in: events } } })
  }
  await cleanup(users, events)
  await closeDb()
})

async function india() {
  const row = await db.markets.findUniqueOrThrow({ where: { code: "IN" } })
  return feeScheduleFromMarket(row as MarketFeeRow, new Date())
}

type TypeSpec = { quantity: number; price?: number; sold?: number; max?: number; startsAt?: Date; hidden?: boolean }

/** A published native-ticketed event with ticket types (quantity, price in paise), priced by `rule`. */
async function ticketedEvent(...types: TypeSpec[]) {
  return ticketedEventWith("standard", ...types)
}

async function ticketedEventWith(rule: FeeRule, ...types: TypeSpec[]) {
  const host = await makeUser(testId("th-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({
    where: { id: eventId },
    data: {
      ticketing_mode: "native",
      ticket_fee_schedule: await india(),
      ticketing_enabled_at: new Date(),
      ticket_fee_rule: rule,
      end_time: new Date(Date.now() + 86_400_000),
    },
  })
  const ids: string[] = []
  for (const [i, t] of types.entries()) {
    const row = await db.ticket_types.create({
      data: {
        event_id: eventId,
        name: `Tier ${i}`,
        price_minor: t.price ?? 49_900,
        quantity: t.quantity,
        sold: t.sold ?? 0,
        max_per_order: t.max ?? 10,
        sale_starts_at: t.startsAt ?? null,
        hidden: t.hidden ?? false,
        sort: i,
      },
      select: { id: true },
    })
    ids.push(row.id)
  }
  return { eventId, ids }
}

async function buyers(n: number) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await makeUser(testId("th-buyer")))
  users.push(...ids)
  return ids
}

const reserve = (eventId: string, buyerId: string, lines: ReserveInput["lines"]) => reserveTickets({ eventId, buyerId, lines })

/** The hold ran out twenty minutes ago. The clock is the server's, so the row is moved, not the clock. */
async function lapse(result: Awaited<ReturnType<typeof reserve>>) {
  if (!result.ok) throw new Error(`setup refused: ${result.reason}`)
  await db.ticket_orders.update({ where: { id: result.orderId }, data: { hold_expires_at: new Date(Date.now() - 20 * 60_000) } })
  return result.orderId
}

const one = (ticketTypeId: string, quantity = 1) => [{ ticketTypeId, quantity }]

const typeRow = (id: string) => db.ticket_types.findUniqueOrThrow({ where: { id }, select: { sold: true, held: true, quantity: true } })

describe("concurrent orders never oversell", () => {
  it("twelve buyers racing for five tickets: exactly five holds", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    const people = await buyers(12)

    const results = await Promise.all(people.map((b) => reserve(eventId, b, [{ ticketTypeId: ids[0], quantity: 1 }])))

    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(Array(7).fill("sold_out"))
    expect(await typeRow(ids[0])).toEqual({ sold: 0, held: 5, quantity: 5 })
    expect(await db.ticket_orders.count({ where: { event_id: eventId, status: "pending" } })).toBe(5)
  })

  it("orders of two racing for five: two fit, the rest are refused whole, never partly held", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    const people = await buyers(6)

    const results = await Promise.all(people.map((b) => reserve(eventId, b, [{ ticketTypeId: ids[0], quantity: 2 }])))

    expect(results.filter((r) => r.ok)).toHaveLength(2)
    expect((await typeRow(ids[0])).held).toBe(4)
    const lines = await db.ticket_order_lines.aggregate({ where: { event_id: eventId }, _sum: { quantity: true } })
    expect(lines._sum.quantity).toBe(4)
  })

  it("orders naming two types in opposite orders do not deadlock", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 6 }, { quantity: 6 })
    const people = await buyers(8)
    const [a, b] = ids

    const results = await Promise.all(
      people.map((p, i) =>
        reserve(eventId, p, i % 2 ? [{ ticketTypeId: a, quantity: 1 }, { ticketTypeId: b, quantity: 1 }] : [{ ticketTypeId: b, quantity: 1 }, { ticketTypeId: a, quantity: 1 }])
      )
    )

    expect(results.filter((r) => r.ok)).toHaveLength(6)
    expect((await typeRow(a)).held).toBe(6)
    expect((await typeRow(b)).held).toBe(6)
  })
})

describe("the CHECK refuses an oversell on its own", () => {
  it("held past quantity", async () => {
    const { ids } = await ticketedEvent({ quantity: 3 })
    await expect(db.ticket_types.update({ where: { id: ids[0] }, data: { held: 4 } })).rejects.toThrow(/ticket_types_not_oversold/)
  })

  it("sold plus held past quantity, written as raw SQL with no lock at all", async () => {
    const { ids } = await ticketedEvent({ quantity: 3, sold: 2 })
    await expect(db.$executeRaw`UPDATE ticket_types SET held = held + 2 WHERE id = ${ids[0]}::uuid`).rejects.toThrow(/ticket_types_not_oversold/)
    expect(await typeRow(ids[0])).toEqual({ sold: 2, held: 0, quantity: 3 })
  })
})

describe("what a hold writes", () => {
  it("a pending order expiring in ten minutes, its lines, and the fee breakdown as charged", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 10, price: 49_900 })
    const [buyer] = await buyers(1)
    const before = Date.now()

    const result = await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 2 }])

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: result.orderId }, include: { lines: true } })
    const expected = ticketFees({
      schedule: await india(),
      paidTicketsBefore: 0,
      lines: [{ ticketTypeId: ids[0], unitPriceMinor: 49_900, quantity: 2 }],
      rule: "standard",
      feesAbsorbed: false,
    })
    expect(order).toMatchObject({
      status: "pending",
      buyer_id: buyer,
      currency: "INR",
      subtotal_minor: 99_800,
      service_fee_minor: 4_990,
      service_fee_tax_minor: 898,
      processing_fee_minor: 2_494,
      total_minor: expected.totals.totalMinor,
      fees_absorbed: false,
      provider_payment_ref: null,
    })
    expect(order.hold_expires_at.getTime()).toBeGreaterThanOrEqual(before + HOLD_MINUTES * 60_000)
    expect(order.hold_expires_at.getTime()).toBeLessThanOrEqual(Date.now() + HOLD_MINUTES * 60_000)
    expect(order.lines).toEqual([expect.objectContaining({ ticket_type_id: ids[0], quantity: 2, unit_price_minor: 49_900 })])
    expect(order.fee_breakdown).toEqual(JSON.parse(JSON.stringify(expected)))
  })

  it("numbers tickets after those sold, so an order at 99 sold straddles into 3.5%", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 200, price: 100_000, sold: 99 })
    const [buyer] = await buyers(1)

    const result = await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 2 }])

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    expect(result.breakdown.lines[0].segments.map((s) => [s.quantity, s.bps])).toEqual([[1, 500], [1, 350]])
  })

  it("never counts held seats toward the slab: holding seats cannot cheapen anybody's fee (security H3)", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 200, price: 100_000, sold: 95 })
    const [squatter, buyer] = await buyers(2)
    expect((await reserve(eventId, squatter, one(ids[0], 10))).ok).toBe(true)

    const result = await reserve(eventId, buyer, one(ids[0], 2))

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    expect(result.breakdown.paidTicketsBefore).toBe(95)
    expect(result.breakdown.lines[0].segments.map((s) => [s.quantity, s.bps])).toEqual([[2, 500]])
  })

  it("numbers an order's tickets dearest first, whatever order the request listed them in", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 200, price: 100_000, sold: 99 }, { quantity: 50, price: 300_000 })
    const [cheap, dear] = ids
    const [buyer] = await buyers(1)

    const result = await reserve(eventId, buyer, [{ ticketTypeId: cheap, quantity: 1 }, { ticketTypeId: dear, quantity: 1 }])

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    expect(result.breakdown.lines.map((l) => [l.ticketTypeId, l.segments[0].bps])).toEqual([[dear, 500], [cheap, 350]])
  })

  it("prices with the rule stored on the event, not anything the request says (security H4)", async () => {
    const { eventId, ids } = await ticketedEventWith("pro", { quantity: 10, price: 100_000 })
    const [buyer] = await buyers(1)
    // A request carrying its own pricing is ignored: the type has no such field, the row decides.
    const request = { eventId, buyerId: buyer, lines: one(ids[0]), pricing: { pro: false, founding: { ticketedEventsBefore: 0, enabledAt: new Date() } } }

    const result = await reserveTickets(request as ReserveInput)

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    expect(result.breakdown.rule).toBe("pro")
    expect(result.breakdown.lines[0].segments[0].bps).toBe(350)
  })

  it("writes a subtotal that is the sum of its lines", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 10, price: 49_900 }, { quantity: 10, price: 129_900 })
    const [buyer] = await buyers(1)

    const result = await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 3 }, { ticketTypeId: ids[1], quantity: 2 }])

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: result.orderId }, include: { lines: true } })
    expect(order.subtotal_minor).toBe(order.lines.reduce((s, l) => s + l.quantity * l.unit_price_minor, 0))
    expect(order.subtotal_minor).toBe(3 * 49_900 + 2 * 129_900)
  })

  it("takes the organiser's choice to absorb fees from the event", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 10, price: 100_000 })
    await db.events.update({ where: { id: eventId }, data: { fees_absorbed: true } })
    const [buyer] = await buyers(1)

    const result = await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 1 }])

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: result.orderId } })
    expect(order).toMatchObject({ fees_absorbed: true, total_minor: 100_000 })
  })
})

describe("refusals", () => {
  it("while TICKETING is off", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    const [buyer] = await buyers(1)
    process.env.TICKETING = "false"
    try {
      expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 1 }])).toEqual({ ok: false, reason: "ticketing_off" })
    } finally {
      process.env.TICKETING = "true"
    }
    expect((await typeRow(ids[0])).held).toBe(0)
  })

  it("an event not selling natively", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    await db.events.update({ where: { id: eventId }, data: { ticketing_mode: "off" } })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 1 }])).toEqual({ ok: false, reason: "not_on_sale" })
  })

  it("a draft event", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    await db.events.update({ where: { id: eventId }, data: { status: "draft" } })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 1 }])).toEqual({ ok: false, reason: "not_on_sale" })
  })

  it("a type whose sale has not started", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5, startsAt: new Date(Date.now() + 3_600_000) })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 1 }])).toEqual({ ok: false, reason: "not_on_sale" })
  })

  it("an event that has ended", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - 7_200_000), end_time: new Date(Date.now() - 60_000) } })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 1 }])).toEqual({ ok: false, reason: "not_on_sale" })
  })

  it("a type whose sale has ended", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    await db.ticket_types.update({ where: { id: ids[0] }, data: { sale_ends_at: new Date(Date.now() - 60_000) } })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 1 }])).toEqual({ ok: false, reason: "not_on_sale" })
  })

  it("a buyer already holding the most open orders one person may hold for the event", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 50 })
    const [buyer, other] = await buyers(2)
    for (let i = 0; i < MAX_PENDING_PER_BUYER; i++) expect((await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 1 }])).ok).toBe(true)

    expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 1 }])).toEqual({ ok: false, reason: "too_many_holds" })
    expect((await reserve(eventId, other, [{ ticketTypeId: ids[0], quantity: 1 }])).ok).toBe(true)
  })

  it("the cap counts only live holds: an expired one does not hold the buyer back", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 50 })
    const [buyer] = await buyers(1)
    for (let i = 0; i < MAX_PENDING_PER_BUYER; i++) await lapse(await reserve(eventId, buyer, one(ids[0])))
    expect((await reserve(eventId, buyer, one(ids[0]))).ok).toBe(true)
  })

  it("an order whose total would not fit the column", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 100, price: 2_000_000_000, max: 100 })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 2 }])).toEqual({ ok: false, reason: "bad_lines" })
    expect((await typeRow(ids[0])).held).toBe(0)
  })

  it(`more than ${MAX_SEATS_PER_BUYER} seats in one order, across its lines, before any lock is taken`, async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 50, max: 100 }, { quantity: 50, max: 100 })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 6 }, { ticketTypeId: ids[1], quantity: 5 }])).toEqual({ ok: false, reason: "over_order_limit" })
    expect(await reserve(eventId, buyer, one(ids[0], MAX_SEATS_PER_BUYER + 1))).toEqual({ ok: false, reason: "over_order_limit" })
    expect((await typeRow(ids[0])).held).toBe(0)
  })

  it("more than the per-order limit", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 50, max: 4 })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, [{ ticketTypeId: ids[0], quantity: 5 }])).toEqual({ ok: false, reason: "over_order_limit" })
  })

  it("a hidden ticket type, even to a request that knows its id (security H2)", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5, hidden: true })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, one(ids[0]))).toEqual({ ok: false, reason: "unknown_ticket_type" })
    expect((await typeRow(ids[0])).held).toBe(0)
  })

  it("a private event (security M5)", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    await db.events.update({ where: { id: eventId }, data: { visibility: "private" } })
    const [buyer] = await buyers(1)
    // Its own answer since Phase 2 (contract §2 `private`), still never a hold.
    expect(await reserve(eventId, buyer, one(ids[0]))).toEqual({ ok: false, reason: "private" })
    expect((await typeRow(ids[0])).held).toBe(0)
  })

  it("a buyer under the event's minimum age, by birth date, and one whose age is unknown (security M5)", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    await db.events.update({ where: { id: eventId }, data: { min_age: 21 } })
    const [young, unknown, adult] = await buyers(3)
    const yearsAgo = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear() - n, 0, 1))
    // A stored age says 30; the birth date says 19, and wins (lib/age.ts ageFrom).
    await db.profiles.create({ data: { id: young, age: 30, date_of_birth: yearsAgo(19) } })
    await db.profiles.create({ data: { id: adult, date_of_birth: yearsAgo(30) } })

    expect(await reserve(eventId, young, one(ids[0]))).toEqual({ ok: false, reason: "under_age" })
    expect(await reserve(eventId, unknown, one(ids[0]))).toEqual({ ok: false, reason: "under_age" })
    expect((await reserve(eventId, adult, one(ids[0]))).ok).toBe(true)
  })

  it("a suspended or deleted buyer", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    const [suspended, deleted] = await buyers(2)
    await db.user.update({ where: { id: suspended }, data: { suspended_at: new Date() } })
    await db.user.update({ where: { id: deleted }, data: { deletedAt: new Date() } })
    expect(await reserve(eventId, suspended, one(ids[0]))).toEqual({ ok: false, reason: "buyer_not_allowed" })
    expect(await reserve(eventId, deleted, one(ids[0]))).toEqual({ ok: false, reason: "buyer_not_allowed" })
  })

  it("an order of free tickets only: free stays RSVP and capacity, never an order (§4.4)", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5, price: 0 })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, one(ids[0]))).toEqual({ ok: false, reason: "free_order" })
    expect((await typeRow(ids[0])).held).toBe(0)
    expect(await db.ticket_orders.count({ where: { event_id: eventId } })).toBe(0)
  })

  it("absorbed fees that would exceed the price: an answer, not a 500 (security M6)", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5, price: 500 })
    await db.events.update({ where: { id: eventId }, data: { fees_absorbed: true } })
    const [buyer] = await buyers(1)
    expect(await reserve(eventId, buyer, one(ids[0]))).toEqual({ ok: false, reason: "fees_exceed_price" })
    expect((await typeRow(ids[0])).held).toBe(0)
  })

  it("another event's ticket type", async () => {
    const mine = await ticketedEvent({ quantity: 5 })
    const theirs = await ticketedEvent({ quantity: 5 })
    const [buyer] = await buyers(1)
    expect(await reserve(mine.eventId, buyer, [{ ticketTypeId: theirs.ids[0], quantity: 1 }])).toEqual({ ok: false, reason: "unknown_ticket_type" })
    expect((await typeRow(theirs.ids[0])).held).toBe(0)
  })

  it.each([
    ["no lines", []],
    ["a zero quantity", [{ quantity: 0 }]],
    ["a fractional quantity", [{ quantity: 1.5 }]],
    ["the same type twice", [{ quantity: 1 }, { quantity: 1 }]],
  ])("malformed lines: %s", async (_name, shape) => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    const [buyer] = await buyers(1)
    const lines = shape.map((l) => ({ ticketTypeId: ids[0], quantity: l.quantity }))
    expect(await reserve(eventId, buyer, lines)).toEqual({ ok: false, reason: "bad_lines" })
  })
})

describe("one buyer cannot hold the room (security H1)", () => {
  it(`stops a buyer at ${MAX_SEATS_PER_BUYER} seats across their holds, and a second account is its own buyer`, async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 100 })
    const [hoarder, other] = await buyers(2)
    expect((await reserve(eventId, hoarder, one(ids[0], 6))).ok).toBe(true)

    expect(await reserve(eventId, hoarder, one(ids[0], 5))).toEqual({ ok: false, reason: "too_many_seats" })
    expect((await reserve(eventId, hoarder, one(ids[0], 4))).ok).toBe(true)
    expect((await typeRow(ids[0])).held).toBe(10)
    expect((await reserve(eventId, other, one(ids[0], 2))).ok).toBe(true)
  })

  it("counts paid seats too: a buyer who paid for ten holds no more", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 100 })
    const [buyer] = await buyers(1)
    const paid = await reserve(eventId, buyer, one(ids[0], MAX_SEATS_PER_BUYER))
    if (!paid.ok) throw new Error(`setup refused: ${paid.reason}`)
    await db.ticket_orders.update({ where: { id: paid.orderId }, data: { status: "paid", provider_payment_ref: `pay_${testId("cap")}`, paid_at: new Date() } })

    expect(await reserve(eventId, buyer, one(ids[0]))).toEqual({ ok: false, reason: "too_many_seats" })
  })

  it("does not count a hold that ran out", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 100 })
    const [buyer] = await buyers(1)
    await lapse(await reserve(eventId, buyer, one(ids[0], MAX_SEATS_PER_BUYER)))
    expect((await reserve(eventId, buyer, one(ids[0], MAX_SEATS_PER_BUYER))).ok).toBe(true)
  })

  it("twenty concurrent orders from one buyer: never past the cap", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 100 })
    const [buyer] = await buyers(1)

    await Promise.all(Array.from({ length: 20 }, () => reserve(eventId, buyer, one(ids[0], 3))))

    const seats = await db.ticket_order_lines.aggregate({ where: { event_id: eventId }, _sum: { quantity: true } })
    expect(seats._sum.quantity).toBeLessThanOrEqual(MAX_SEATS_PER_BUYER)
    expect((await typeRow(ids[0])).held).toBe(seats._sum.quantity)
  })
})

describe("an expired hold is given back by the next reserve, without the sweeper (database HIGH 2)", () => {
  it("the last seat, held and lapsed, goes to the next buyer at once", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 1 })
    const [first, second] = await buyers(2)
    const lapsed = await lapse(await reserve(eventId, first, one(ids[0])))

    const result = await reserve(eventId, second, one(ids[0]))

    expect(result.ok).toBe(true)
    expect((await db.ticket_orders.findUniqueOrThrow({ where: { id: lapsed } })).status).toBe("expired")
    expect(await typeRow(ids[0])).toEqual({ sold: 0, held: 1, quantity: 1 })
  })
})

describe("a lock held too long is busy, not a stuck connection (database HIGH 1)", () => {
  it("answers busy after the lock timeout and holds nothing", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    const [buyer] = await buyers(1)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM ticket_types WHERE id = ${ids[0]}::uuid FOR UPDATE`
        locked()
        await released
      },
      { timeout: 20_000 }
    )
    await isLocked
    const started = Date.now()

    const result = await reserve(eventId, buyer, one(ids[0]))

    const waited = Date.now() - started
    release()
    await holder
    expect(result).toEqual({ ok: false, reason: "busy" })
    expect(waited).toBeGreaterThanOrEqual(1_900)
    expect(waited).toBeLessThan(8_000)
    expect((await typeRow(ids[0])).held).toBe(0)
  })
})

describe("releasing expired holds", () => {
  it("expires a hold past its time, gives its quantity back, and leaves a live one alone", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    const [early, late] = await buyers(2)
    const held = await reserve(eventId, early, one(ids[0], 2))
    const live = await reserve(eventId, late, one(ids[0]))
    if (!live.ok) throw new Error("setup refused")
    const stale = await lapse(held)
    expect((await typeRow(ids[0])).held).toBe(3)

    const first = await releaseExpiredHolds()

    expect(first.released).toBeGreaterThanOrEqual(1)
    expect((await typeRow(ids[0])).held).toBe(1)
    expect((await db.ticket_orders.findUniqueOrThrow({ where: { id: stale } })).status).toBe("expired")
    expect((await db.ticket_orders.findUniqueOrThrow({ where: { id: live.orderId } })).status).toBe("pending")
  })

  it("is idempotent: a second sweep, or two at once, releases nothing twice", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    const people = await buyers(3)
    const holds = []
    for (const p of people) holds.push(await reserve(eventId, p, one(ids[0])))
    for (const h of holds) await lapse(h)

    await Promise.all([releaseExpiredHolds(), releaseExpiredHolds(), releaseExpiredHolds()])
    await releaseExpiredHolds()

    expect((await typeRow(ids[0])).held).toBe(0)
    expect(await db.ticket_orders.count({ where: { event_id: eventId, status: "expired" } })).toBe(3)
  })

  it("puts the released seats back on sale", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 1 })
    const [a, b, c] = await buyers(3)
    const held = await reserve(eventId, a, one(ids[0]))
    expect(await reserve(eventId, b, one(ids[0]))).toEqual({ ok: false, reason: "sold_out" })
    await lapse(held)

    await releaseExpiredHolds()

    expect((await typeRow(ids[0])).held).toBe(0)
    expect((await reserve(eventId, c, one(ids[0]))).ok).toBe(true)
  })

  it("works in batches", async () => {
    const { eventId, ids } = await ticketedEvent({ quantity: 5 })
    const people = await buyers(3)
    const holds = []
    for (const p of people) holds.push(await reserve(eventId, p, one(ids[0])))
    for (const h of holds) await lapse(h)

    let released = 0
    for (let pass = 0; pass < 10 && (await typeRow(ids[0])).held > 0; pass++) released += (await releaseExpiredHolds({ limit: 1 })).released

    expect((await typeRow(ids[0])).held).toBe(0)
    expect(released).toBeGreaterThanOrEqual(3)
  })
})
