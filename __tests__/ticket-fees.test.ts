import {
  FOUNDING_OFFER_ENDS_AT,
  FeesExceedPriceError,
  TicketFeeError,
  feeRuleFor,
  feeScheduleFromMarket,
  foundingOfferApplies,
  parseFeeSchedule,
  ticketFees,
  type FeeInput,
  type FeeSchedule,
} from "@/lib/ticket-fees"

/**
 * The booking fee (ticketing-business-model.md §2), in integer minor units.
 * Every amount here is paise unless it says otherwise: ₹499 is 49_900.
 */

const IN: FeeSchedule = feeScheduleFromMarket(
  {
    code: "IN",
    currency: "INR",
    ticketing_mode: "native",
    ticket_fee_slab_from: [1, 101, 501],
    ticket_fee_slab_bps: [500, 350, 200],
    ticket_fee_min_minor: 1_000,
    ticket_fee_tax_bps: 1_800,
    ticket_processing_bps: 236,
  },
  new Date("2026-11-02T00:00:00Z")
)

const NOT_FOUNDING = { ticketedEventsBefore: 3, enabledAt: new Date("2026-12-01T00:00:00Z") }

function fees(over: Partial<FeeInput> & Pick<FeeInput, "lines">) {
  return ticketFees({
    schedule: IN,
    paidTicketsBefore: 0,
    rule: "standard",
    feesAbsorbed: false,
    ...over,
  })
}

const line = (unitPriceMinor: number, quantity: number, ticketTypeId = "t1") => ({ ticketTypeId, unitPriceMinor, quantity })

describe("the worked examples in ticketing-business-model.md", () => {
  it("meetup: 40 × ₹499 is a ₹998 service fee", () => {
    expect(fees({ lines: [line(49_900, 40)] }).totals.serviceFeeMinor).toBe(99_800)
  })

  it("tech-week mixer: 300 × ₹799 is ₹9,589 (each ticket's fee rounded to the paisa: 3.5% of ₹799 is ₹27.97)", () => {
    expect(fees({ lines: [line(79_900, 300)] }).totals.serviceFeeMinor).toBe(958_900)
  })

  it("concert: 2,000 × ₹1,499 is ₹73,453 by the per-ticket rule, two rupees over the doc's unrounded ₹73,451", () => {
    // 100 × ₹74.95 + 400 × ₹52.47 (52.465 rounded half up) + 1,500 × ₹29.98.
    // The doc's ₹73,451 is the same sum with ₹52.465 left unrounded, and its
    // ₹9,589 above is the rounded one: no single rule gives both. The rule
    // here is the per-ticket one, because a refund returns one ticket's fee.
    expect(fees({ lines: [line(149_900, 2_000)] }).totals.serviceFeeMinor).toBe(7_345_300)
  })

  it("cheap open mic: 60 × ₹149 is ₹600, the ₹10 minimum on every ticket", () => {
    expect(fees({ lines: [line(14_900, 60)] }).totals.serviceFeeMinor).toBe(60_000)
  })

  it("buyer view of one ₹499 ticket: service ₹24.95 + GST ₹4.49 + processing ₹12.47 = ₹41.91", () => {
    const b = fees({ lines: [line(49_900, 1)] })
    expect(b.totals).toEqual({
      subtotalMinor: 49_900,
      serviceFeeMinor: 2_495,
      serviceFeeTaxMinor: 449,
      processingFeeMinor: 1_247,
      bookingFeeMinor: 4_191,
      totalMinor: 54_091,
      organizerPayoutMinor: 49_900,
    })
  })
})

describe("slabs are marginal per event", () => {
  it("an order straddling ticket 100/101 charges 5% up to 100 and 3.5% from 101", () => {
    const b = fees({ paidTicketsBefore: 98, lines: [line(100_000, 4)] })
    // Tickets 99 and 100 at 5% (₹50), 101 and 102 at 3.5% (₹35).
    expect(b.lines[0].segments).toEqual([
      expect.objectContaining({ quantity: 2, bps: 500, serviceFeeMinor: 10_000 }),
      expect.objectContaining({ quantity: 2, bps: 350, serviceFeeMinor: 7_000 }),
    ])
    expect(b.totals.serviceFeeMinor).toBe(2 * 5_000 + 2 * 3_500)
  })

  it("counts the tickets already sold: ticket 501 onwards is 2%", () => {
    const b = fees({ paidTicketsBefore: 500, lines: [line(100_000, 1)] })
    expect(b.lines[0].segments[0]).toMatchObject({ bps: 200, serviceFeeMinor: 2_000 })
  })

  it("numbers tickets across lines dearest first, whatever order the caller sent them in (security H3)", () => {
    // Ticket 100 is the last at 5%. Sent cheap-first, a buyer would put the ₹2,000 ticket on 3.5%.
    for (const lines of [[line(100_000, 1, "a"), line(200_000, 1, "b")], [line(200_000, 1, "b"), line(100_000, 1, "a")]]) {
      const b = fees({ paidTicketsBefore: 99, lines })
      expect(b.lines.map((l) => [l.ticketTypeId, l.segments[0].bps])).toEqual([["b", 500], ["a", 350]])
    }
  })

  it("breaks a price tie on the type id, so the same order always prices the same", () => {
    const sent = [line(100_000, 1, "z"), line(100_000, 1, "a")]
    expect(fees({ paidTicketsBefore: 99, lines: sent }).lines.map((l) => l.ticketTypeId)).toEqual(["a", "z"])
    expect(fees({ paidTicketsBefore: 99, lines: [...sent].reverse() }).lines.map((l) => l.ticketTypeId)).toEqual(["a", "z"])
  })

  it("free tickets carry no fee and do not advance the slab", () => {
    const b = fees({ paidTicketsBefore: 99, lines: [line(0, 5, "free"), line(100_000, 1, "paid")] })
    const free = b.lines.find((l) => l.ticketTypeId === "free")!
    const paid = b.lines.find((l) => l.ticketTypeId === "paid")!
    expect(free).toMatchObject({ subtotalMinor: 0, serviceFeeMinor: 0, processingFeeMinor: 0, totalMinor: 0 })
    expect(paid.segments[0]).toMatchObject({ bps: 500 })
    expect(b.paidTicketsAfter).toBe(100)
  })
})

describe("the per-ticket minimum", () => {
  it("lifts a fee below it to the minimum", () => {
    expect(fees({ lines: [line(10_000, 1)] }).totals.serviceFeeMinor).toBe(1_000)
  })

  it("leaves a fee above it alone", () => {
    expect(fees({ lines: [line(30_000, 1)] }).totals.serviceFeeMinor).toBe(1_500)
  })
})

describe("Pro starts one slab lower", () => {
  it("is 3.5% for tickets 1–100 and 2% from 101", () => {
    const b = fees({ rule: "pro", paidTicketsBefore: 99, lines: [line(100_000, 2)] })
    expect(b.rule).toBe("pro")
    expect(b.lines[0].segments.map((s) => s.bps)).toEqual([350, 200])
  })

  it("stays at the last slab past 500", () => {
    expect(fees({ rule: "pro", paidTicketsBefore: 600, lines: [line(100_000, 1)] }).lines[0].segments[0].bps).toBe(200)
  })
})

describe("the founding offer", () => {
  const founding = { ticketedEventsBefore: 0, enabledAt: new Date("2027-01-15T00:00:00Z") }

  it("is 2% flat on an organisation's first three ticketed events", () => {
    const b = fees({ rule: "founding", paidTicketsBefore: 0, lines: [line(100_000, 3)] })
    expect(b.rule).toBe("founding")
    expect(b.lines[0].segments).toEqual([expect.objectContaining({ quantity: 3, bps: 200, serviceFeeMinor: 6_000 })])
  })

  it("beats Pro", () => {
    expect(feeRuleFor({ pro: true, founding })).toBe("founding")
    expect(feeRuleFor({ pro: true, founding: NOT_FOUNDING })).toBe("pro")
    expect(feeRuleFor({ pro: false, founding: NOT_FOUNDING })).toBe("standard")
  })

  it("keeps the per-ticket minimum", () => {
    expect(fees({ rule: "founding", lines: [line(14_900, 1)] }).totals.serviceFeeMinor).toBe(1_000)
  })

  it("is not the fourth event's", () => {
    expect(foundingOfferApplies({ ticketedEventsBefore: 2, enabledAt: founding.enabledAt })).toBe(true)
    expect(foundingOfferApplies({ ticketedEventsBefore: 3, enabledAt: founding.enabledAt })).toBe(false)
  })

  it("ends with 31 March 2027 in India, judged when ticketing was turned on", () => {
    expect(FOUNDING_OFFER_ENDS_AT.toISOString()).toBe("2027-03-31T18:30:00.000Z")
    expect(foundingOfferApplies({ ticketedEventsBefore: 0, enabledAt: new Date("2027-03-31T18:29:59Z") })).toBe(true)
    expect(foundingOfferApplies({ ticketedEventsBefore: 0, enabledAt: new Date("2027-03-31T18:30:00Z") })).toBe(false)
  })
})

describe("tax on the service fee is market data", () => {
  it("is 18% in India", () => {
    expect(fees({ lines: [line(100_000, 1)] }).totals.serviceFeeTaxMinor).toBe(900)
  })

  it("is whatever the market row says, zero included", () => {
    const b = fees({ schedule: { ...IN, serviceTaxBps: 0 }, lines: [line(100_000, 1)] })
    expect(b.totals.serviceFeeTaxMinor).toBe(0)
  })
})

describe("who pays the fees", () => {
  it("buyer pays: processing is charged on price + service + tax, and the organiser gets the full price", () => {
    const b = fees({ lines: [line(100_000, 2)] })
    // service 5,000 + GST 900; processing 2.36% of 105,900 = 2,499.24 → 2,499.
    expect(b.lines[0]).toMatchObject({
      serviceFeeMinor: 10_000,
      serviceFeeTaxMinor: 1_800,
      processingFeeMinor: 4_998,
      totalMinor: 216_798,
      organizerPayoutMinor: 200_000,
    })
  })

  it("absorbed: the buyer pays the price, processing is on the price, and the fees come out of the payout", () => {
    const b = fees({ feesAbsorbed: true, lines: [line(100_000, 2)] })
    // processing 2.36% of 100,000 = 2,360.
    expect(b.lines[0]).toMatchObject({
      serviceFeeMinor: 10_000,
      serviceFeeTaxMinor: 1_800,
      processingFeeMinor: 4_720,
      bookingFeeMinor: 0,
      totalMinor: 200_000,
      organizerPayoutMinor: 200_000 - 10_000 - 1_800 - 4_720,
    })
  })

  it("absorbed: refuses a price the fees would exceed, rather than a negative payout, as its own error", () => {
    // Its own class, so a reserve can answer it as a refusal rather than a 500 (security M6).
    expect(() => fees({ feesAbsorbed: true, lines: [line(500, 1)] })).toThrow(FeesExceedPriceError)
    expect(new FeesExceedPriceError("x")).toBeInstanceOf(TicketFeeError)
  })
})

describe("integer money: the parts always add up", () => {
  const cases: Array<[string, Partial<FeeInput> & Pick<FeeInput, "lines">]> = [
    ["straddle, buyer pays", { paidTicketsBefore: 97, lines: [line(79_900, 7, "a"), line(14_900, 3, "b"), line(0, 2, "c")] }],
    ["straddle, absorbed", { feesAbsorbed: true, paidTicketsBefore: 497, lines: [line(149_900, 9, "a"), line(52_300, 4, "b")] }],
    ["pro across both slabs", { rule: "pro", paidTicketsBefore: 95, lines: [line(33_333, 11)] }],
  ]

  it.each(cases)("%s", (_name, input) => {
    const b = fees(input)
    const sum = (k: keyof (typeof b.lines)[number]) => b.lines.reduce((s, l) => s + (l[k] as number), 0)
    for (const l of b.lines) {
      expect(l.bookingFeeMinor).toBe(b.feesAbsorbed ? 0 : l.serviceFeeMinor + l.serviceFeeTaxMinor + l.processingFeeMinor)
      expect(l.totalMinor).toBe(l.subtotalMinor + l.bookingFeeMinor)
      expect(l.subtotalMinor).toBe(l.unitPriceMinor * l.quantity)
      // Each segment's amounts are per ticket × its count, so a refund of one ticket is exact.
      expect(l.serviceFeeMinor).toBe(l.segments.reduce((s, g) => s + g.serviceFeeMinor, 0))
      expect(l.quantity).toBe(l.segments.reduce((s, g) => s + g.quantity, 0))
      for (const g of l.segments) {
        expect(g.serviceFeeMinor).toBe(g.perTicket.serviceFeeMinor * g.quantity)
        expect(g.serviceFeeTaxMinor).toBe(g.perTicket.serviceFeeTaxMinor * g.quantity)
        expect(g.processingFeeMinor).toBe(g.perTicket.processingFeeMinor * g.quantity)
      }
      for (const v of Object.values(l)) if (typeof v === "number") expect(Number.isInteger(v)).toBe(true)
    }
    expect(b.totals.subtotalMinor).toBe(sum("subtotalMinor"))
    expect(b.totals.serviceFeeMinor).toBe(sum("serviceFeeMinor"))
    expect(b.totals.serviceFeeTaxMinor).toBe(sum("serviceFeeTaxMinor"))
    expect(b.totals.processingFeeMinor).toBe(sum("processingFeeMinor"))
    expect(b.totals.bookingFeeMinor).toBe(sum("bookingFeeMinor"))
    expect(b.totals.totalMinor).toBe(sum("totalMinor"))
    expect(b.totals.organizerPayoutMinor).toBe(sum("organizerPayoutMinor"))
  })

  it("rounds half up, once per ticket per part", () => {
    // 3.5% of ₹799 is 2,796.5 paise → 2,797.
    expect(fees({ paidTicketsBefore: 100, lines: [line(79_900, 1)] }).totals.serviceFeeMinor).toBe(2_797)
  })
})

describe("input is refused, not guessed at", () => {
  it.each([
    ["a negative price", [line(-1, 1)]],
    ["a fractional price", [line(10.5, 1)]],
    ["a zero quantity", [line(100, 0)]],
    ["no lines", []],
  ])("%s", (_name, lines) => {
    expect(() => fees({ lines })).toThrow(TicketFeeError)
  })

  it("a negative count already sold", () => {
    expect(() => fees({ paidTicketsBefore: -1, lines: [line(100, 1)] })).toThrow(TicketFeeError)
  })

  it("an amount too large to multiply exactly", () => {
    expect(() => fees({ lines: [line(Number.MAX_SAFE_INTEGER, 1)] })).toThrow(TicketFeeError)
  })
})

describe("the schedule snapshot", () => {
  it("round-trips through JSON (events.ticket_fee_schedule)", () => {
    expect(parseFeeSchedule(JSON.parse(JSON.stringify(IN)))).toEqual(IN)
  })

  it.each([
    ["slabs not starting at ticket 1", { ...IN, slabs: [{ fromTicket: 2, bps: 500 }] }],
    ["slabs out of order", { ...IN, slabs: [{ fromTicket: 1, bps: 500 }, { fromTicket: 501, bps: 200 }, { fromTicket: 101, bps: 350 }] }],
    ["a rate over 100%", { ...IN, slabs: [{ fromTicket: 1, bps: 10_001 }] }],
    ["a lower-case currency", { ...IN, currency: "inr" }],
  ])("refuses %s", (_name, bad) => {
    expect(() => parseFeeSchedule(bad)).toThrow(TicketFeeError)
  })

  it("refuses a market row whose slab arrays differ in length", () => {
    expect(() =>
      feeScheduleFromMarket(
        { code: "IN", currency: "INR", ticketing_mode: "native", ticket_fee_slab_from: [1, 101], ticket_fee_slab_bps: [500], ticket_fee_min_minor: 0, ticket_fee_tax_bps: 0, ticket_processing_bps: 0 },
        new Date()
      )
    ).toThrow(TicketFeeError)
  })
})
