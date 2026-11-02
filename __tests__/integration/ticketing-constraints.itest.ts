import { createHash, randomBytes } from "node:crypto"

import { httpsUrl } from "@/lib/https-url"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * Every ticketing CHECK, the seeded market rows and the composite keys
 * (SCRUM-1008). All of them live only in migration SQL, so a `db push`
 * database has none and code tested against one can write rows production
 * refuses. Each test names the constraint it expects to fire.
 */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.tickets.deleteMany({ where: { event_id: { in: events } } })
    await db.ticket_order_lines.deleteMany({ where: { event_id: { in: events } } })
    await db.ticket_orders.deleteMany({ where: { event_id: { in: events } } })
    await db.ticket_types.deleteMany({ where: { event_id: { in: events } } })
  }
  await cleanup(users, events)
  await closeDb()
})

async function world() {
  const host = await makeUser(testId("tc-host"), "organizer")
  const buyer = await makeUser(testId("tc-buyer"))
  users.push(host, buyer)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const type = await db.ticket_types.create({ data: { event_id: eventId, name: "General", price_minor: 49_900, quantity: 10 }, select: { id: true } })
  return { host, buyer, eventId, typeId: type.id }
}

const order = (eventId: string, buyerId: string, over: Record<string, unknown> = {}) => ({
  event_id: eventId,
  buyer_id: buyerId,
  currency: "INR",
  subtotal_minor: 49_900,
  service_fee_minor: 2_495,
  service_fee_tax_minor: 449,
  processing_fee_minor: 1_247,
  total_minor: 54_091,
  fees_absorbed: false,
  fee_breakdown: {},
  hold_expires_at: new Date(Date.now() + 600_000),
  ...over,
})

const secretHash = () => createHash("sha256").update(randomBytes(32)).digest("hex")

describe("the seeded markets", () => {
  it("India sells natively at 5 / 3.5 / 2%, ₹10 minimum, GST 18%, processing 2.36%", async () => {
    expect(await db.markets.findUniqueOrThrow({ where: { code: "IN" } })).toMatchObject({
      currency: "INR",
      ticketing_mode: "native",
      ticket_fee_slab_from: [1, 101, 501],
      ticket_fee_slab_bps: [500, 350, 200],
      ticket_fee_min_minor: 1_000,
      ticket_fee_tax_bps: 1_800,
      ticket_processing_bps: 236,
    })
  })

  it("Canada links out, with a CA$0.75 minimum ready", async () => {
    expect(await db.markets.findUniqueOrThrow({ where: { code: "CA" } })).toMatchObject({ currency: "CAD", ticketing_mode: "external", ticket_fee_min_minor: 75 })
  })
})

describe("markets", () => {
  it.each([
    ["slab arrays of different lengths", "UPDATE markets SET ticket_fee_slab_from = ARRAY[1,101], ticket_fee_slab_bps = ARRAY[500] WHERE code = 'IN'", "markets_ticket_fee_slabs_shape"],
    ["a first slab not at ticket 1", "UPDATE markets SET ticket_fee_slab_from = ARRAY[2,101,501] WHERE code = 'IN'", "markets_ticket_fee_slabs_shape"],
    ["an empty slab list", "UPDATE markets SET ticket_fee_slab_from = ARRAY[]::int[], ticket_fee_slab_bps = ARRAY[]::int[] WHERE code = 'IN'", "markets_ticket_fee_slabs_shape"],
    ["a NULL inside the slabs", "UPDATE markets SET ticket_fee_slab_bps = ARRAY[500,NULL,200] WHERE code = 'IN'", "markets_ticket_fee_slabs_shape"],
    ["a rate over 100%", "UPDATE markets SET ticket_fee_slab_bps = ARRAY[500,350,10001] WHERE code = 'IN'", "markets_ticket_fee_rates_range"],
    ["a negative minimum", "UPDATE markets SET ticketing_mode = 'off', ticket_fee_min_minor = -1 WHERE code = 'IN'", "markets_ticket_fee_rates_range"],
    ["a tax rate over 100%", "UPDATE markets SET ticket_fee_tax_bps = 10001 WHERE code = 'IN'", "markets_ticket_fee_rates_range"],
    ["slab thresholds out of order", "UPDATE markets SET ticket_fee_slab_from = ARRAY[1,501,101] WHERE code = 'IN'", "markets_ticket_fee_slabs_ascending"],
    ["a repeated slab threshold", "UPDATE markets SET ticket_fee_slab_from = ARRAY[1,101,101] WHERE code = 'IN'", "markets_ticket_fee_slabs_ascending"],
    ["no minimum fee in a market that sells", "UPDATE markets SET ticket_fee_min_minor = 0 WHERE code = 'IN'", "markets_ticket_fee_min_when_selling"],
    ["no minimum fee in a market that links out", "UPDATE markets SET ticket_fee_min_minor = 0 WHERE code = 'CA'", "markets_ticket_fee_min_when_selling"],
  ])("refuses %s", async (_name, sql, constraint) => {
    // Rolled back either way, so a constraint that failed to fire cannot leave India mispriced for the next suite.
    const attempt = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(sql)
      throw new Error("no constraint fired")
    })
    await expect(attempt).rejects.toThrow(new RegExp(constraint))
  })
})

describe("events", () => {
  it("external needs a URL", async () => {
    const { eventId } = await world()
    await expect(db.events.update({ where: { id: eventId }, data: { ticketing_mode: "external" } })).rejects.toThrow(/events_ticketing_external_needs_url/)
  })

  it.each(["http://tickets.example/e/1", "javascript:alert(1)", "https://", "https://user@evil.example/", "https://a.example/with space"])(
    "refuses %s as a ticket URL",
    async (url) => {
      const { eventId } = await world()
      await expect(db.events.update({ where: { id: eventId }, data: { external_ticket_url: url } })).rejects.toThrow(/events_external_ticket_url_https/)
    }
  )

  it("takes what the writer's validator (httpsUrl) lets through", async () => {
    const { eventId } = await world()
    for (const raw of ["https://www.eventbrite.ca/e/blendn-night-123?aff=x#t", "HTTPS://Showpass.com/blendn"]) {
      const url = httpsUrl().parse(raw)
      await db.events.update({ where: { id: eventId }, data: { ticketing_mode: "external", external_ticket_url: url } })
    }
  })

  it("native needs the fee snapshot", async () => {
    const { eventId } = await world()
    await expect(
      db.events.update({ where: { id: eventId }, data: { ticketing_mode: "native", ticketing_enabled_at: new Date(), ticket_fee_rule: "standard" } })
    ).rejects.toThrow(/events_ticketing_native_needs_schedule/)
  })

  it("native needs to have been turned on, with its rule (enableTicketing)", async () => {
    const { eventId } = await world()
    await expect(db.events.update({ where: { id: eventId }, data: { ticketing_mode: "native", ticket_fee_schedule: {} } })).rejects.toThrow(
      /events_ticketing_native_needs_enablement/
    )
  })

  it.each([
    ["a rule with no time", { ticket_fee_rule: "pro" as const }],
    ["a time with no rule", { ticketing_enabled_at: new Date() }],
  ])("the rule and when it was decided go together: refuses %s", async (_name, data) => {
    const { eventId } = await world()
    await expect(db.events.update({ where: { id: eventId }, data })).rejects.toThrow(/events_ticket_fee_rule_with_enabled_at/)
  })

  it("a venue day is never ticketed", async () => {
    const { eventId } = await world()
    await expect(
      db.$executeRaw`UPDATE events SET kind = 'venue_day', ticketing_mode = 'external', external_ticket_url = 'https://x.example' WHERE id = ${eventId}::uuid`
    ).rejects.toThrow(/events_venue_day_not_ticketed/)
  })

  it("an event with orders cannot be deleted, and takes nothing with it", async () => {
    const { eventId, buyer } = await world()
    await db.ticket_orders.create({ data: order(eventId, buyer) })
    await expect(db.$executeRaw`DELETE FROM events WHERE id = ${eventId}::uuid`).rejects.toThrow(/ticket_orders_event_id_fkey/)
  })
})

describe("ticket types", () => {
  it.each([
    ["a negative price", { price_minor: -1 }, "ticket_types_price_non_negative"],
    ["a negative quantity", { quantity: -1 }, "ticket_types_counts_non_negative"],
    ["sold past quantity", { quantity: 2, sold: 3 }, "ticket_types_not_oversold"],
    ["a per-order limit of 0", { max_per_order: 0 }, "ticket_types_max_per_order_range"],
    ["a blank name", { name: "   " }, "ticket_types_name_length"],
    ["a sale that ends before it starts", { sale_starts_at: new Date("2026-12-02"), sale_ends_at: new Date("2026-12-01") }, "ticket_types_sale_window_order"],
  ])("refuses %s", async (_name, over, constraint) => {
    const { eventId } = await world()
    await expect(db.ticket_types.create({ data: { event_id: eventId, name: "T", price_minor: 100, quantity: 5, ...over } })).rejects.toThrow(new RegExp(constraint))
  })

  it("takes a free ticket", async () => {
    const { eventId } = await world()
    await db.ticket_types.create({ data: { event_id: eventId, name: "Free", price_minor: 0, quantity: 5 } })
  })
})

describe("orders", () => {
  it.each([
    ["a lower-case currency", { currency: "inr" }, "ticket_orders_currency_shape"],
    ["a negative amount", { processing_fee_minor: -1, total_minor: 54_091 - 1_248 }, "ticket_orders_amounts_non_negative"],
    ["a total that is not its parts", { total_minor: 54_092 }, "ticket_orders_total_is_its_parts"],
    ["absorbed fees still charged to the buyer", { fees_absorbed: true }, "ticket_orders_total_is_its_parts"],
    ["paid with no payment ref", { status: "paid", paid_at: new Date() }, "ticket_orders_paid_has_payment_ref"],
    ["refunded with no payment ref", { status: "refunded", paid_at: new Date() }, "ticket_orders_paid_has_payment_ref"],
    ["paid with a ref but no time", { status: "paid", provider_payment_ref: "pay_x" }, "ticket_orders_paid_has_payment_ref"],
    ["a breakdown that is not an object", { fee_breakdown: [1, 2] }, "ticket_orders_fee_breakdown_object"],
    ["an order of nothing: free tickets never make one", { subtotal_minor: 0, service_fee_minor: 0, service_fee_tax_minor: 0, processing_fee_minor: 0, total_minor: 0 }, "ticket_orders_total_positive"],
  ])("refuses %s", async (_name, over, constraint) => {
    const { eventId, buyer } = await world()
    await expect(db.ticket_orders.create({ data: order(eventId, buyer, over) })).rejects.toThrow(new RegExp(constraint))
  })

  it("takes an absorbed order whose total is the subtotal, and a paid one with its ref", async () => {
    const { eventId, buyer } = await world()
    await db.ticket_orders.create({ data: order(eventId, buyer, { fees_absorbed: true, total_minor: 49_900 }) })
    await db.ticket_orders.create({ data: order(eventId, buyer, { status: "paid", provider_payment_ref: `pay_${testId("p")}`, paid_at: new Date() }) })
  })

  it("one provider payment, one order", async () => {
    const { eventId, buyer } = await world()
    const ref = `pay_${testId("dup")}`
    await db.ticket_orders.create({ data: order(eventId, buyer, { status: "paid", provider_payment_ref: ref, paid_at: new Date() }) })
    await expect(db.ticket_orders.create({ data: order(eventId, buyer, { status: "paid", provider_payment_ref: ref, paid_at: new Date() }) })).rejects.toMatchObject({ code: "P2002" })
  })

  it("an order with lines cannot be deleted out from under them (RESTRICT, database 10)", async () => {
    const { eventId, buyer, typeId } = await world()
    const o = await db.ticket_orders.create({
      data: { ...order(eventId, buyer), lines: { create: [{ ticket_type_id: typeId, quantity: 1, unit_price_minor: 49_900 }] } },
      select: { id: true },
    })
    await expect(db.$executeRaw`DELETE FROM ticket_orders WHERE id = ${o.id}::uuid`).rejects.toThrow(/ticket_order_lines_order_id_event_id_fkey/)
    expect(await db.ticket_order_lines.count({ where: { order_id: o.id } })).toBe(1)
  })

  it("a line's ticket type is on its order's event", async () => {
    const mine = await world()
    const theirs = await world()
    const o = await db.ticket_orders.create({ data: order(mine.eventId, mine.buyer), select: { id: true } })
    await expect(
      db.$executeRaw`INSERT INTO ticket_order_lines (order_id, ticket_type_id, event_id, quantity, unit_price_minor) VALUES (${o.id}::uuid, ${theirs.typeId}::uuid, ${mine.eventId}::uuid, 1, 100)`
    ).rejects.toThrow(/ticket_order_lines_ticket_type_id_event_id_fkey/)
  })

  it.each([
    ["a zero quantity", 0, 100, "ticket_order_lines_quantity_positive"],
    ["a negative price", 1, -1, "ticket_order_lines_price_non_negative"],
  ])("a line refuses %s", async (_name, quantity, price, constraint) => {
    const { eventId, buyer, typeId } = await world()
    const o = await db.ticket_orders.create({ data: order(eventId, buyer), select: { id: true } })
    await expect(
      db.ticket_order_lines.create({ data: { order_id: o.id, ticket_type_id: typeId, event_id: eventId, quantity, unit_price_minor: price } })
    ).rejects.toThrow(new RegExp(constraint))
  })
})

describe("tickets", () => {
  async function paidOrder() {
    const w = await world()
    const o = await db.ticket_orders.create({ data: order(w.eventId, w.buyer, { status: "paid", provider_payment_ref: `pay_${testId("t")}`, paid_at: new Date() }), select: { id: true } })
    const ticket = (over: Record<string, unknown> = {}) => ({
      order_id: o.id,
      ticket_type_id: w.typeId,
      event_id: w.eventId,
      holder_id: w.buyer,
      door_code: "AB23CD",
      qr_secret_hash: secretHash(),
      ...over,
    })
    return { ...w, orderId: o.id, ticket }
  }

  it("one door code per event", async () => {
    const { ticket } = await paidOrder()
    await db.tickets.create({ data: ticket() })
    await expect(db.tickets.create({ data: ticket() })).rejects.toMatchObject({ code: "P2002" })
  })

  it("the same door code at another event is fine", async () => {
    const a = await paidOrder()
    const b = await paidOrder()
    await db.tickets.create({ data: a.ticket() })
    await db.tickets.create({ data: b.ticket() })
  })

  it.each<[string, Record<string, unknown>, string]>([
    ["a lower-case door code", { door_code: "ab23cd" }, "tickets_door_code_shape"],
    ["a five-character door code", { door_code: "AB23C" }, "tickets_door_code_shape"],
    ...["0", "O", "1", "I", "L", "U"].map((c): [string, Record<string, unknown>, string] => [`a door code with ${c} in it`, { door_code: `AB23C${c}` }, "tickets_door_code_shape"]),
    ["a QR secret stored as itself", { qr_secret_hash: randomBytes(32).toString("base64url") }, "tickets_qr_secret_hash_shape"],
    ["an upper-case hash", { qr_secret_hash: secretHash().toUpperCase() }, "tickets_qr_secret_hash_shape"],
  ])("refuses %s", async (_name, over, constraint) => {
    const p = await paidOrder()
    await expect(db.tickets.create({ data: p.ticket(over) })).rejects.toThrow(new RegExp(constraint))
  })

  it("refuses a redeemer with no redemption time", async () => {
    const p = await paidOrder()
    await expect(db.tickets.create({ data: p.ticket({ redeemed_by: p.host }) })).rejects.toThrow(/tickets_redeemer_needs_time/)
  })

  it("a ticket only for a paid order (trigger tickets_order_must_be_paid)", async () => {
    const p = await paidOrder()
    const pending = await db.ticket_orders.create({ data: order(p.eventId, p.buyer), select: { id: true } })
    await expect(db.tickets.create({ data: p.ticket({ order_id: pending.id }) })).rejects.toThrow(/tickets_order_must_be_paid/)
    // Nor moved onto one afterwards.
    const t = await db.tickets.create({ data: p.ticket() })
    await expect(db.tickets.update({ where: { id: t.id }, data: { order_id: pending.id } })).rejects.toThrow(/tickets_order_must_be_paid/)
  })

  it("a ticket is on its order's event", async () => {
    const mine = await paidOrder()
    const theirs = await world()
    await expect(db.tickets.create({ data: mine.ticket({ event_id: theirs.eventId, ticket_type_id: theirs.typeId }) })).rejects.toThrow(/tickets_order_id_event_id_fkey/)
  })
})

describe("legal acceptances", () => {
  it.each([
    ["a document key with spaces", { document_key: "ticketing terms" }, "legal_acceptances_document_key_shape"],
    ["a version that is not a number", { version: "latest" }, "legal_acceptances_version_shape"],
  ])("refuses %s", async (_name, over, constraint) => {
    const org = await db.organisations.create({ data: { display_name: testId("tc-org") }, select: { id: true } })
    const user = await makeUser(testId("tc-acceptor"), "organizer")
    await expect(
      db.legal_acceptances.create({
        data: { org_id: org.id, user_id: user, document_key: "organizer-ticketing-terms", version: "0.1", document_sha256: secretHash(), ...over },
      })
    ).rejects.toThrow(new RegExp(constraint))
    // Nothing was written, so these can go.
    await db.organisations.delete({ where: { id: org.id } })
    await db.user.delete({ where: { id: user } })
  })
})
