import { listPrice } from "@/lib/event-list-price"

/*
 * What a Pulse row may say about tickets (Flow 3b · Nearby, N1; SCRUM-1022): `ticketed`, and `fromPrice` only when a ticket
 * is really for sale. Never a hidden tier's price, never a free-only "From ₹0", never a sold-out or ended tier's.
 */

const NOW = new Date("2026-11-04T12:00:00Z")
const LATER = new Date("2026-11-08T22:00:00Z")
const type = (over: Partial<Parameters<typeof listPrice>[1][number]> = {}) => ({
  price_minor: 79900,
  quantity: 100,
  sold: 0,
  held: 0,
  hidden: false,
  sale_starts_at: null,
  sale_ends_at: null,
  ...over,
})
const native = { ticketing_mode: "native", ticket_fee_schedule: { currency: "INR" }, end_time: LATER }

describe("listPrice", () => {
  it("the lowest price on sale, in the event's currency", () => {
    expect(listPrice(native, [type({ price_minor: 129900 }), type({ price_minor: 79900 })], NOW, true)).toEqual({
      ticketed: true,
      fromPrice: { minor: 79900, currency: "INR" },
    })
  })

  it("never a hidden tier, a free tier, a sold-out tier or one not on sale yet or any more", () => {
    const types = [
      type({ price_minor: 100, hidden: true }),
      type({ price_minor: 0 }),
      type({ price_minor: 200, sold: 100 }),
      type({ price_minor: 300, sold: 90, held: 10 }),
      type({ price_minor: 400, sale_starts_at: new Date("2026-11-05T00:00:00Z") }),
      type({ price_minor: 500, sale_ends_at: new Date("2026-11-03T00:00:00Z") }),
      type({ price_minor: 99900 }),
    ]
    expect(listPrice(native, types, NOW, true).fromPrice).toEqual({ minor: 99900, currency: "INR" })
  })

  it("free-only or nothing on sale: ticketed, and no price", () => {
    expect(listPrice(native, [type({ price_minor: 0 })], NOW, true)).toEqual({ ticketed: true, fromPrice: null })
    expect(listPrice(native, [type({ sold: 100 })], NOW, true)).toEqual({ ticketed: true, fromPrice: null })
  })

  it("an ended event sells nothing", () => {
    expect(listPrice({ ...native, end_time: new Date("2026-11-04T11:00:00Z") }, [type()], NOW, true).fromPrice).toBeNull()
  })

  it("external tickets (an organiser's own page): ticketed, never a price we did not set", () => {
    expect(listPrice({ ...native, ticketing_mode: "external" }, [type()], NOW, true)).toEqual({ ticketed: true, fromPrice: null })
  })

  it("off, or ticketing switched off on this deployment: not ticketed (the control)", () => {
    expect(listPrice({ ...native, ticketing_mode: "off" }, [type()], NOW, true)).toEqual({ ticketed: false, fromPrice: null })
    expect(listPrice(native, [type()], NOW, false)).toEqual({ ticketed: false, fromPrice: null })
  })
})

it("a schedule with no readable currency costs the row its price, never the list", () => {
  expect(listPrice({ ...native, ticket_fee_schedule: { nonsense: true } }, [type()], NOW, true)).toEqual({ ticketed: true, fromPrice: null })
})
