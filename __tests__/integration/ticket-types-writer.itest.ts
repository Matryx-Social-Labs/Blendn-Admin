import { saveTicketType, TICKET_TYPES_MAX } from "@/lib/ticket-types"

import { closeDb, db, makeUser, testId } from "./helpers"
import { newWorld, teardown, ticketEnv, ticketedEvent } from "./ticket-world"

/**
 * The ticket types writer (SCRUM-1014, contract §8.10, §8.11): who may write,
 * the 20-a-event cap, no free types, a quantity never under what is sold, and
 * a price change that is recorded and never reaches a ticket already sold.
 */

const w = newWorld()
let restore: () => void

beforeAll(() => {
  restore = ticketEnv()
})
afterAll(async () => {
  await teardown(w)
  restore()
  await closeDb()
})

const general = (over: Record<string, unknown> = {}) => ({
  name: "General",
  price: "1,499",
  quantity: "100",
  maxPerOrder: "10",
  salesStart: "",
  salesEnd: "",
  onSale: "on",
  ...over,
})

async function hostOf(eventId: string) {
  const e = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { organizer_id: true } })
  return { id: e.organizer_id, role: "organizer" as const }
}

describe("who may write ticket types", () => {
  it("lets a member of the event's organization write, and nobody else", async () => {
    const { eventId, orgId } = await ticketedEvent(w, [])
    // A colleague at the same organization, who did not create the event (CLAUDE.md: organization-shaped).
    const colleague = await makeUser(testId("tix-colleague"), "organizer")
    w.users.push(colleague)
    await db.organisation_members.create({ data: { org_id: orgId, user_id: colleague, role: "staff" } })
    const stranger = await makeUser(testId("tix-stranger"), "organizer")
    w.users.push(stranger)

    const mine = await saveTicketType(eventId, { id: colleague, role: "organizer" }, general())
    expect(mine).toMatchObject({ ok: true })

    const theirs = await saveTicketType(eventId, { id: stranger, role: "organizer" }, general({ name: "Sneaky" }))
    expect(theirs).toEqual({ ok: false, reason: "not_authorized", message: expect.any(String) })
    expect(await db.ticket_types.count({ where: { event_id: eventId, name: "Sneaky" } })).toBe(0)
  })

  it("refuses a venue owner, who operates the night but does not edit it", async () => {
    const { eventId } = await ticketedEvent(w, [])
    const venueOwner = await makeUser(testId("tix-venue"), "organizer")
    w.users.push(venueOwner)
    const venueOrg = await db.organisations.create({ data: { kind: "company", display_name: testId("tix-venue-org"), status: "verified" } })
    w.orgs.push(venueOrg.id)
    await db.organisation_members.create({ data: { org_id: venueOrg.id, user_id: venueOwner, role: "owner" } })
    const venue = await db.venues.create({
      data: { name: testId("tix-venue"), city: "Bengaluru", latitude: 12.97, longitude: 77.6, owner_org_id: venueOrg.id, claimed_at: new Date(Date.now() - 86_400_000) },
    })
    await db.events.update({ where: { id: eventId }, data: { venue_id: venue.id } })

    const res = await saveTicketType(eventId, { id: venueOwner, role: "organizer" }, general())
    expect(res).toMatchObject({ ok: false, reason: "not_authorized" })

    await db.events.update({ where: { id: eventId }, data: { venue_id: null } })
    await db.venues.delete({ where: { id: venue.id } })
  })

  it("refuses an event that is not selling natively, so types never precede the terms", async () => {
    const { eventId, host } = await ticketedEvent(w, [])
    await db.events.update({ where: { id: eventId }, data: { ticketing_mode: "off", ticketing_enabled_at: null, ticket_fee_rule: null } })
    const res = await saveTicketType(eventId, { id: host, role: "organizer" }, general())
    expect(res).toMatchObject({ ok: false, reason: "not_selling" })
  })
})

describe("what a type may be", () => {
  it(`creates at most ${TICKET_TYPES_MAX} types for an event, hidden ones counted`, async () => {
    const { eventId } = await ticketedEvent(w, [])
    const host = await hostOf(eventId)
    for (let i = 0; i < TICKET_TYPES_MAX; i++) {
      const res = await saveTicketType(eventId, host, general({ name: `T${i}`, onSale: i % 2 ? "on" : "" }))
      expect(res).toMatchObject({ ok: true })
    }
    const over = await saveTicketType(eventId, host, general({ name: "One too many" }))
    expect(over).toMatchObject({ ok: false, reason: "cap_reached" })
    expect(await db.ticket_types.count({ where: { event_id: eventId } })).toBe(TICKET_TYPES_MAX)
  })

  it("holds the cap against a writer whose twentieth type is not committed yet", async () => {
    const { eventId } = await ticketedEvent(w, [])
    const host = await hostOf(eventId)
    for (let i = 0; i < TICKET_TYPES_MAX - 1; i++) await saveTicketType(eventId, host, general({ name: `R${i}` }))
    // Another writer holds the event and has inserted the twentieth, uncommitted. A save that
    // counted without waiting for it would see 19 and insert a twenty-first.
    let release = () => {}
    const held = new Promise<void>((r) => (release = r))
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid FOR NO KEY UPDATE`
      await tx.ticket_types.create({ data: { event_id: eventId, name: "Held", price_minor: 100, quantity: 1, sort: 19 } })
      await held
    }, { timeout: 20_000 })
    await new Promise((r) => setTimeout(r, 150))
    const racing = Promise.all([saveTicketType(eventId, host, general({ name: "A" })), saveTicketType(eventId, host, general({ name: "B" }))])
    await new Promise((r) => setTimeout(r, 400))
    release()
    await holder
    const results = await racing
    expect(results.filter((r) => r.ok)).toHaveLength(0)
    expect(await db.ticket_types.count({ where: { event_id: eventId } })).toBe(TICKET_TYPES_MAX)
  })

  it("refuses a free type: free is RSVP plus capacity (decision 4, §8.11)", async () => {
    const { eventId } = await ticketedEvent(w, [])
    const host = await hostOf(eventId)
    for (const price of ["0", "0.00", "", "-5", "abc", "1.234"]) {
      expect(await saveTicketType(eventId, host, general({ price }))).toMatchObject({ ok: false, reason: "invalid" })
    }
    // Control: the same form with a price goes through.
    expect(await saveTicketType(eventId, host, general({ price: "0.50" }))).toMatchObject({ ok: true })
    const row = await db.ticket_types.findFirstOrThrow({ where: { event_id: eventId }, select: { price_minor: true } })
    expect(row.price_minor).toBe(50)
  })

  it("stores the form as minor units, the window in the event's own timezone, and on sale as not hidden", async () => {
    const { eventId } = await ticketedEvent(w, [])
    await db.events.update({ where: { id: eventId }, data: { timezone: "Asia/Kolkata" } })
    const host = await hostOf(eventId)
    const res = await saveTicketType(eventId, host, general({ salesStart: "2026-11-20T10:00", salesEnd: "2026-11-21T17:30", onSale: "" }))
    if (!res.ok) throw new Error(res.message)
    const row = await db.ticket_types.findUniqueOrThrow({ where: { id: res.id } })
    expect(row).toMatchObject({ name: "General", price_minor: 149_900, quantity: 100, max_per_order: 10, hidden: true })
    expect(row.sale_starts_at?.toISOString()).toBe("2026-11-20T04:30:00.000Z")
    expect(row.sale_ends_at?.toISOString()).toBe("2026-11-21T12:00:00.000Z")
  })

  it("refuses a most-per-order over 10 and a sale that ends before it starts", async () => {
    const { eventId } = await ticketedEvent(w, [])
    const host = await hostOf(eventId)
    expect(await saveTicketType(eventId, host, general({ maxPerOrder: "11" }))).toMatchObject({ ok: false, reason: "invalid" })
    expect(await saveTicketType(eventId, host, general({ salesStart: "2026-11-21T10:00", salesEnd: "2026-11-20T10:00" }))).toMatchObject({
      ok: false,
      reason: "invalid",
    })
  })
})

describe("editing a type that has sold", () => {
  it("refuses a quantity under what is sold and held", async () => {
    const { eventId, typeIds } = await ticketedEvent(w, [{ quantity: 50, sold: 30 }])
    const host = await hostOf(eventId)
    const res = await saveTicketType(eventId, host, { ...general({ quantity: "29" }), id: typeIds[0] })
    expect(res).toMatchObject({ ok: false, reason: "below_sold" })
    expect(await saveTicketType(eventId, host, { ...general({ quantity: "30" }), id: typeIds[0] })).toMatchObject({ ok: true })
  })

  it("changes the price for new orders only, and records the change", async () => {
    const { eventId, typeIds, orgId } = await ticketedEvent(w, [{ quantity: 50, sold: 2, price: 99_900 }])
    const host = await hostOf(eventId)
    // A line already sold at the old price: what a paid order keeps.
    const order = await db.ticket_orders.create({
      data: {
        event_id: eventId,
        buyer_id: host.id,
        status: "paid",
        currency: "INR",
        subtotal_minor: 199_800,
        service_fee_minor: 0,
        service_fee_tax_minor: 0,
        processing_fee_minor: 0,
        total_minor: 199_800,
        fees_absorbed: true,
        fee_breakdown: {},
        provider_payment_ref: `pay_${testId("x").slice(-12)}`,
        paid_at: new Date(),
        hold_expires_at: new Date(),
        lines: { create: { ticket_type_id: typeIds[0], quantity: 2, unit_price_minor: 99_900 } },
      },
    })

    const res = await saveTicketType(eventId, host, { ...general({ name: "Tier 0", price: "1,199", quantity: "50" }), id: typeIds[0] })
    expect(res).toMatchObject({ ok: true })

    expect((await db.ticket_types.findUniqueOrThrow({ where: { id: typeIds[0] } })).price_minor).toBe(119_900)
    const line = await db.ticket_order_lines.findUniqueOrThrow({ where: { order_id_ticket_type_id: { order_id: order.id, ticket_type_id: typeIds[0] } } })
    expect(line.unit_price_minor).toBe(99_900)
    const audit = await db.audit_logs.findFirst({ where: { action: "ticket_type.price_changed", resource_id: typeIds[0] } })
    expect(audit).toMatchObject({ user_id: host.id, org_id: orgId })
    expect(audit?.details).toMatchObject({ eventId, fromMinor: 99_900, toMinor: 119_900, sold: 2 })

    // Control: an edit that leaves the price alone writes no price row.
    await saveTicketType(eventId, host, { ...general({ name: "Renamed", price: "1,199", quantity: "50" }), id: typeIds[0] })
    expect(await db.audit_logs.count({ where: { action: "ticket_type.price_changed", resource_id: typeIds[0] } })).toBe(1)
  })

  it("refuses a type id from another event", async () => {
    const a = await ticketedEvent(w, [{ quantity: 5 }])
    const b = await ticketedEvent(w, [])
    const res = await saveTicketType(b.eventId, await hostOf(b.eventId), { ...general(), id: a.typeIds[0] })
    expect(res).toMatchObject({ ok: false, reason: "not_found" })
  })
})
