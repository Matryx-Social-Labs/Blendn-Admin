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
 * its 28 days of data, and no mandate past `created` open. A venue on Venue Pro
 * (paid or a founding grant) said it too, and a paused mandate offered a Buy
 * the server refuses.
 */
const READY = { dataSince: new Date("2026-08-01T00:00:00Z"), chargeableFrom: new Date("2026-08-29T00:00:00Z"), dataDays: 28, chargeable: true }
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
])("%s past its 28 days says Venue Pro can be bought, and offers Buy", (_label, venue) => {
  const html = render(venue)
  expect(html).toContain("28 of 28 days of data · Venue Pro can be bought")
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
  expect(html).toContain("28 of 28 days of data")
})

it("review L7: another organisation's mandate still open here: a neutral line in place of Buy, and nothing about it", () => {
  const html = render(row({ openElsewhere: true }))
  expect(html).toContain("A previous plan on this venue is still being closed — contact support.")
  expect(html).not.toContain("can be bought")
  expect(offersBuy(html)).toBe(false)
  // Whose, which plan, or how much is never said.
  expect(html).not.toMatch(/sub_|renews|cancel/i)
})
