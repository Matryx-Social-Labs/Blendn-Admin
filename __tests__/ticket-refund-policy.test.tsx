import { renderToStaticMarkup } from "react-dom/server"

import { RefundButton } from "@/app/dashboard/events/[id]/tickets/refund-button"
import { buyerRefundRefusal, policyRefundDebit, policyRefundMinor, refundUntil, type BuyerRefundFacts } from "@/lib/ticket-refund-policy"

import { WORST } from "./support/long-text"

/*
 * A refund under the event's policy (SCRUM-1113, owner 2026-11-25): the full ticket price, absorbed fees charged to the
 * organization, the buyer's window from the event's start; and the Refund dialog that says so (mockup
 * tickets-refund-20261125, option B).
 */

jest.mock("@/app/dashboard/events/[id]/tickets/actions", () => ({ refundSale: jest.fn() }))
jest.mock("@/app/dashboard/events/[id]/tickets/use-action", () => ({ useTicketAction: () => ({ pending: false, run: jest.fn() }) }))

const HOUR = 3_600_000
const start = new Date("2026-12-20T14:30:00.000Z")
const absorbed = { subtotal_minor: 99_800, total_minor: 99_800, service_fee_minor: 4_990, service_fee_tax_minor: 898, processing_fee_minor: 2_355 }
const buyerPaid = { subtotal_minor: 99_800, total_minor: 108_182, service_fee_minor: 4_990, service_fee_tax_minor: 898, processing_fee_minor: 2_494 }

describe("the amount", () => {
  it("is the full ticket price whoever paid the fees, and charges the organization only what it absorbed", () => {
    expect([policyRefundMinor(absorbed), policyRefundDebit(absorbed)]).toEqual([99_800, 4_990 + 898 + 2_355])
    expect([policyRefundMinor(buyerPaid), policyRefundDebit(buyerPaid)]).toEqual([99_800, 0])
  })
})

describe("the window", () => {
  const event = { status: "published", deleted_at: null, refund_policy: "until_24h" as const, start_time: start }
  const facts = (over: Partial<BuyerRefundFacts> = {}): BuyerRefundFacts => ({ status: "paid", payoutStatus: "on_hold", ticketUsed: false, event, ...over })
  const at = (hoursBefore: number, ms = 0) => new Date(start.getTime() - hoursBefore * HOUR + ms)

  it("ends exactly 24 hours or 7 days before the start, and never opens under no refunds", () => {
    expect(refundUntil(event)).toEqual(at(24))
    expect(refundUntil({ ...event, refund_policy: "until_7d" })).toEqual(at(168))
    expect(refundUntil({ ...event, refund_policy: "none" })).toBeNull()
    expect(buyerRefundRefusal(facts(), at(24))).toBeNull()
    expect(buyerRefundRefusal(facts(), at(24, 1))).toBe("refund_window_closed")
  })

  it.each<[string, Partial<BuyerRefundFacts>]>([
    ["not_paid", { status: "pending" }],
    ["event_canceled", { event: { ...event, status: "cancelled" } }],
    ["event_canceled", { event: { ...event, deleted_at: start } }],
    ["payout_released", { payoutStatus: "releasing" }],
    ["payout_released", { payoutStatus: "released" }],
    ["refund_policy_none", { event: { ...event, refund_policy: "none" } }],
    ["ticket_used", { ticketUsed: true }],
  ])("refuses %s", (reason, over) => {
    expect(buyerRefundRefusal(facts(over), at(48))).toBe(reason)
  })

  it.each(["pending", "on_hold", "no_account", null])("allows a payout that is %s", (payoutStatus) => {
    expect(buyerRefundRefusal(facts({ payoutStatus }), at(48))).toBeNull()
  })
})

describe("the Refund dialog", () => {
  const dialog = (over: Partial<Parameters<typeof RefundButton>[0]> = {}) =>
    renderToStaticMarkup(
      <RefundButton eventId="e" orderId="o" orderRef="C41E07B2" label="attendee-3f9a1c2b7d04" quantity={2} types="General" refundMinor={299_800} bookingFeeMinor={0} chargedFeesMinor={0} currency="INR" {...over} />
    )
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

  it("says what the buyer gets and what the organization is charged when it absorbed the fees", () => {
    const html = text(dialog({ chargedFeesMinor: 12_656 }))
    expect(html).toContain("gets the full price of 2 General tickets back.")
    expect(html).toContain("Buyer gets back ₹2,998.00 Fees you absorbed, charged to you ₹126.56")
    expect(html).not.toContain("less the fees")
    expect(dialog({ chargedFeesMinor: 12_656 })).toMatch(/aria-describedby="\S+-d \S+-l"/)
  })

  it("shows no charge when the buyer paid the fees, and that the booking fee stays", () => {
    const html = text(dialog({ bookingFeeMinor: 14_318 }))
    expect(html).toContain("₹2,998.00 back, the price of 2 General tickets.")
    expect(html).toContain("The ₹143.18 booking fee is not refunded")
    expect(html).not.toContain("charged to you")
  })

  it("keeps money whole at its longest", () => {
    const html = dialog({ types: WORST.ticketType, refundMinor: 124_800_000, chargedFeesMinor: 5_269_040 })
    expect(html).toMatch(/<dd class="[^"]*whitespace-nowrap[^"]*">₹12,48,000\.00/)
    expect(html).toMatch(/<dd class="[^"]*whitespace-nowrap[^"]*">₹52,690\.40/)
  })
})
