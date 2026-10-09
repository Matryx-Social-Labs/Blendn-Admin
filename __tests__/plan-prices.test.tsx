import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }))
jest.mock("next/script", () => ({ __esModule: true, default: () => null }))
jest.mock("@/lib/billing-actions", () => ({ cancelAnalytics: jest.fn(), startAnalyticsCheckout: jest.fn(), startEventPassCheckout: jest.fn() }))

import { AnalyticsBuy, CheckoutProvider, EventPassBuy } from "@/app/dashboard/plan/checkout"

/*
 * G11: what the Plan page's buy controls print is the price table and nothing
 * else. Every ₹ figure is one of the GST-inclusive prices, or part of the
 * "₹list + ₹GST GST" split beneath it. Written as literals, not read from the
 * table under test.
 */
const SHOWN = new Set(["₹2,359", "₹23,588", "₹589"])
const SPLITS = ["₹1,999 + ₹360 GST", "₹19,990 + ₹3,598 GST", "₹499 + ₹90 GST"]

function rupeeFigures(html: string): string[] {
  let rest = html
  for (const split of SPLITS) rest = rest.split(split).join("")
  return rest.match(/₹[\d,]+/g) ?? []
}

const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(CheckoutProvider, null, node))

describe("the buy controls print only the table's prices", () => {
  it("Analytics, monthly by default: ₹2,359 with its split", () => {
    const html = render(createElement(AnalyticsBuy, { enabled: true, pending: false }))
    expect(html).toContain("₹1,999 + ₹360 GST")
    expect(rupeeFigures(html).every((f) => SHOWN.has(f))).toBe(true)
    expect(rupeeFigures(html)).toContain("₹2,359")
  })

  it("an Event Pass: ₹589 with its split", () => {
    const html = render(createElement(EventPassBuy, { enabled: true, pending: false, events: [{ id: "e1", label: "Night · 3 Oct" }] }))
    expect(rupeeFigures(html)).toEqual(["₹589"])
  })
})

describe("while a payment is being confirmed", () => {
  it("Buy says why it can't be pressed, and stays focusable (aria-disabled, not disabled)", () => {
    const html = render(createElement(AnalyticsBuy, { enabled: true, pending: true }))
    expect(html).toContain("A payment is being confirmed")
    expect(html).toMatch(/<button[^>]*aria-disabled="true"/)
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/)
  })

  it("the period is a native radio group with a legend", () => {
    const html = render(createElement(AnalyticsBuy, { enabled: true, pending: false }))
    expect(html.match(/type="radio"/g)).toHaveLength(2)
    expect(html).toContain("<legend")
  })
})
