import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }))
jest.mock("next/script", () => ({ __esModule: true, default: () => null }))
jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/billing-actions", () => ({ cancelAnalytics: jest.fn(), cancelVenuePro: jest.fn(), startVenueProCheckout: jest.fn() }))

import { VenuePlan } from "@/app/dashboard/plan/venue-plan"
import type { VenuePlanRow } from "@/lib/venue-plan"

/*
 * SCRUM-609: a venue's row says "Venue Pro can be bought", and offers Buy,
 * only when the checkout would take it (lib/billing-actions.ts): Listed, past
 * its 90 days of data, and no mandate past `created` open. A venue on Venue Pro
 * (paid or a founding grant) said it too, and a paused mandate offered a Buy
 * the server refuses.
 */
const READY = { dataSince: new Date("2026-08-01T00:00:00Z"), chargeableFrom: new Date("2026-10-30T00:00:00Z"), dataDays: 90, chargeable: true }
const UNTIL = new Date("2026-11-12T00:00:00Z")

function row(overrides: Partial<VenuePlanRow>): VenuePlanRow {
  return {
    venueId: "v1",
    name: "The Humming Tree",
    city: "Bengaluru",
    orgName: "Humming Tree Hospitality",
    owned: true,
    mayBuy: true,
    mayCancel: true,
    pro: null,
    date: null,
    readiness: READY,
    subscriptions: [],
    openElsewhere: false,
    mayBuyHere: true,
    ...overrides,
  }
}

const subscription = (status: string) => ({
  providerRef: "sub_1",
  status,
  currentEnd: UNTIL,
  cancelAtCycleEnd: false,
  createdAt: new Date("2026-10-12T00:00:00Z"),
})

const render = (venue: VenuePlanRow) =>
  renderToStaticMarkup(createElement(VenuePlan, { view: { paymentsOn: true, venues: [venue], payments: [] }, pending: false }))

/** The Buy control: its period is a native radio group. */
const offersBuy = (html: string) => html.includes('type="radio"')

it.each([
  ["a Listed venue", row({})],
  ["a venue whose earlier checkout was abandoned (a `created` mandate, replaced by a new one)", row({ subscriptions: [subscription("created")] })],
])("%s past its 90 days says Venue Pro can be bought, and offers Buy", (_label, venue) => {
  const html = render(venue)
  expect(html).toContain("90 of 90 days of data · Venue Pro can be bought")
  expect(offersBuy(html)).toBe(true)
})

it.each([
  ["paid Venue Pro", row({ pro: { id: "e1", source: "razorpay", startsAt: READY.chargeableFrom, expiresAt: UNTIL }, date: { word: "renews", at: UNTIL }, subscriptions: [subscription("active")] })],
  ["a founding grant", row({ pro: { id: "e2", source: "grant", startsAt: READY.chargeableFrom, expiresAt: UNTIL } })],
  ["a paused mandate", row({ subscriptions: [subscription("halted")] })],
  ["a mandate authorised and not yet charged", row({ subscriptions: [subscription("authenticated")] })],
])("a venue with %s never says Venue Pro can be bought nor offers Buy, and keeps its data count", (_label, venue) => {
  const html = render(venue)
  expect(html).not.toContain("can be bought")
  expect(offersBuy(html)).toBe(false)
  expect(html).toContain("90 of 90 days of data")
})

it("review L7: another organisation's mandate still open here: a neutral line in place of Buy, and nothing about it", () => {
  const html = render(row({ openElsewhere: true }))
  expect(html).toContain("A previous plan on this venue is still being closed — contact support.")
  expect(html).not.toContain("can be bought")
  expect(offersBuy(html)).toBe(false)
  // Whose, which plan, or how much is never said.
  expect(html).not.toMatch(/sub_|renews|cancel/i)
})

it("SCRUM-1320: a venue 40 days in reads 40 of 90 days and its no-charge date, offers no Buy, and the card says three months", () => {
  const html = render(row({ readiness: { dataSince: READY.dataSince, chargeableFrom: READY.chargeableFrom, dataDays: 40, chargeable: false } }))
  expect(html).toContain("40 of 90 days of data · no charge before 30 Oct 2026")
  expect(html).toContain('aria-valuemax="90"')
  expect(html).toContain("Nothing is charged until a venue has three months of data from people going live there.")
  expect(html).not.toContain("weeks")
  expect(offersBuy(html)).toBe(false)
})

it("SCRUM-1320: a venue nobody has gone live at yet says charges start 90 days after, and offers no Buy", () => {
  const html = render(row({ readiness: { dataSince: null, chargeableFrom: null, dataDays: 0, chargeable: false } }))
  expect(html).toContain("No data yet · charges start 90 days after people first go live here")
  expect(offersBuy(html)).toBe(false)
})

describe("SCRUM-1151: a venue whose organisation is outside India (Toronto)", () => {
  const LINE = "Free while we launch in your city."
  const toronto = (overrides: Partial<VenuePlanRow> = {}) => row({ name: "The Drake Hotel Underground and Sky Yard Rooftop, Queen Street West", city: "Toronto", mayBuyHere: false, ...overrides })

  it("past its 90 days: no Buy, no 'can be bought', and the launch line once in place of the price", () => {
    const html = render(toronto())
    expect(offersBuy(html)).toBe(false)
    expect(html).not.toContain("can be bought")
    expect(html.split(LINE)).toHaveLength(2)
    expect(html).not.toMatch(/₹|GST/)
    expect(html).not.toContain("Nothing is charged until")
  })

  it("still counting days: no meter and no charge date, since nothing will be charged", () => {
    const html = render(toronto({ readiness: { dataSince: READY.dataSince, chargeableFrom: READY.chargeableFrom, dataDays: 19, chargeable: false } }))
    expect(html).not.toContain('role="meter"')
    expect(html).not.toContain("no charge before")
    expect(html).toContain("The Drake Hotel Underground")
  })

  it("a paid Venue Pro there keeps its state and its Cancel", () => {
    const html = render(toronto({ pro: { id: "e1", source: "razorpay", startsAt: READY.chargeableFrom, expiresAt: UNTIL }, date: { word: "renews", at: UNTIL }, subscriptions: [subscription("active")] }))
    expect(html).toContain("Venue Pro · renews")
    expect(html).toContain("Cancel at the end of this cycle")
  })

  it("an Indian venue's page is unchanged: price, split and Buy, no launch line", () => {
    const html = render(row({}))
    expect(html).not.toContain(LINE)
    expect(html).toContain("₹3,539")
    expect(offersBuy(html)).toBe(true)
  })
})
