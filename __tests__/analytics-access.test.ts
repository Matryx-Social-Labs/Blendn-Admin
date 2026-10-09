import { decideAccess, FREE_WINDOW_DAYS, mayOpenEvent, type AnalyticsAccess } from "@/lib/analytics-access"
import { held, heldPart } from "@/lib/org-analytics"

jest.mock("@/lib/db", () => ({ db: {} }))

/*
 * DK-U01: the plan gate, as a pure decision. Free, Analytics, expired and
 * halted (both of which leave no live entitlement) against the paywall's
 * start: 30 days after the first event that cleared the floor.
 */
const DAY = 24 * 60 * 60 * 1000
const now = new Date("2026-10-03T12:00:00Z")
const endedAgo = (days: number) => new Date(now.getTime() - days * DAY)

describe("decideAccess", () => {
  it("is open while no event has cleared the floor: the clock has not started", () => {
    expect(decideAccess({ entitled: null, qualifyingEventEnd: null, now })).toEqual({
      org: true,
      reason: "free_window",
      freeUntil: null,
    })
  })

  it("is open for 30 days after the first event that cleared the floor, and locked after", () => {
    const inside = decideAccess({ entitled: null, qualifyingEventEnd: endedAgo(FREE_WINDOW_DAYS - 1), now })
    expect(inside).toMatchObject({ org: true, reason: "free_window" })
    const after = decideAccess({ entitled: null, qualifyingEventEnd: endedAgo(FREE_WINDOW_DAYS + 1), now })
    expect(after).toMatchObject({ org: false, reason: "free" })
    // At the exact end it is over.
    expect(decideAccess({ entitled: null, qualifyingEventEnd: endedAgo(FREE_WINDOW_DAYS), now }).org).toBe(false)
  })

  it("is open with Analytics or a grant, whatever the window", () => {
    expect(decideAccess({ entitled: "analytics", qualifyingEventEnd: endedAgo(400), now })).toMatchObject({ org: true, reason: "analytics" })
    expect(decideAccess({ entitled: "grant", qualifyingEventEnd: endedAgo(400), now })).toMatchObject({ org: true, reason: "grant" })
  })

  it("is locked when a subscription expired or halted: no live entitlement is no entitlement", () => {
    // An expired or halted subscription reaches here as entitled: null.
    expect(decideAccess({ entitled: null, qualifyingEventEnd: endedAgo(90), now }).org).toBe(false)
  })
})

describe("mayOpenEvent", () => {
  const locked: AnalyticsAccess = {
    orgId: "o",
    org: false,
    reason: "free",
    freeUntil: endedAgo(1),
    paidUntil: null,
    firstFreeEventId: "first",
    passEventIds: ["passed"],
  }

  it("opens the first event that cleared the floor and any event with a pass, and nothing else", () => {
    expect(mayOpenEvent(locked, "first")).toBe(true)
    expect(mayOpenEvent(locked, "passed")).toBe(true)
    expect(mayOpenEvent(locked, "another")).toBe(false)
  })

  it("opens every event with Analytics", () => {
    expect(mayOpenEvent({ ...locked, org: true, reason: "analytics" }, "another")).toBe(true)
  })
})

describe("the floors on every new figure", () => {
  it("holds a count of people under 5", () => {
    expect(held(4)).toBeNull()
    expect(held(5)).toBe(5)
  })

  it("holds a part of a group under 5, all of it, or all but one of it", () => {
    expect(heldPart(4, 20)).toBeNull() // min cell
    expect(heldPart(6, 4)).toBeNull() // the group itself is under the floor
    expect(heldPart(12, 12)).toBeNull() // completeness: "all 12 were first-timers" names everyone
    expect(heldPart(11, 12)).toBeNull() // residual: names the one who was not
    expect(heldPart(7, 12)).toBe(7)
  })
})
