import { analyticsAccess, decideAccess, FREE_WINDOW_DAYS, mayOpenEvent, type AnalyticsAccess } from "@/lib/analytics-access"
import { heldPart } from "@/lib/disclosure"
import { held, mergeArrivals } from "@/lib/org-analytics"

const mockDb = {
  events: { findMany: jest.fn() },
  organisations: { findUnique: jest.fn(), updateMany: jest.fn() },
}
const mockCounts = jest.fn()
jest.mock("@/lib/db", () => ({ get db() { return mockDb } }))
jest.mock("@/lib/attendee-counts", () => ({ distinctAttendeeCounts: (ids: string[]) => mockCounts(ids) }))
jest.mock("@/lib/entitlements", () => ({ liveEntitlement: async () => null, eventPassesFor: async () => new Set<string>() }))

/*
 * DK-U01: the plan gate, as a pure decision, with literal dates (never the
 * constant under test): free, Analytics, grant, expired and halted (both of
 * which leave no live entitlement) against the written-once end of the free
 * window.
 */
const DAY = 86_400_000
const now = new Date("2026-10-03T12:00:00Z")

describe("decideAccess", () => {
  it("is open while no event has cleared the floor: the clock has not started", () => {
    expect(decideAccess({ entitled: null, freeUntil: null, now })).toEqual({ org: true, reason: "free_window", freeUntil: null })
  })

  it("is open until the window's end and locked from it", () => {
    expect(decideAccess({ entitled: null, freeUntil: new Date("2026-10-03T12:00:01Z"), now })).toMatchObject({ org: true, reason: "free_window" })
    expect(decideAccess({ entitled: null, freeUntil: new Date("2026-10-03T12:00:00Z"), now })).toMatchObject({ org: false, reason: "free" })
    expect(decideAccess({ entitled: null, freeUntil: new Date("2026-09-01T00:00:00Z"), now })).toMatchObject({ org: false, reason: "free" })
  })

  it("is open with Analytics or a grant, whatever the window", () => {
    expect(decideAccess({ entitled: "analytics", freeUntil: new Date(now.getTime() - 400 * DAY), now })).toMatchObject({ org: true, reason: "analytics" })
    expect(decideAccess({ entitled: "grant", freeUntil: new Date(now.getTime() - 400 * DAY), now })).toMatchObject({ org: true, reason: "grant" })
  })

  it("is locked when a subscription expired or halted: no live entitlement is no entitlement", () => {
    expect(decideAccess({ entitled: null, freeUntil: new Date(now.getTime() - DAY), now }).org).toBe(false)
  })

  it("names a 90-day window: three months free (DECISIONS 2026-11-25)", () => {
    expect(FREE_WINDOW_DAYS).toBe(90)
  })
})

describe("the first event that starts the clock (SCRUM-1269)", () => {
  const seven = { id: "seven", end_time: new Date("2026-08-01T22:00:00Z") }
  const eight = { id: "eight", end_time: new Date("2026-08-20T22:00:00Z") }

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.organisations.findUnique.mockResolvedValue({ analytics_free_until: null, first_free_event_id: null })
    mockDb.organisations.updateMany.mockResolvedValue({ count: 1 })
    mockDb.events.findMany.mockResolvedValueOnce([seven, eight]).mockResolvedValue([])
    mockCounts.mockResolvedValue(new Map([["seven", 7], ["eight", 8]]))
  })

  it("is the first night with 8 people checked in; a night of 7 does not start it", async () => {
    const access = await analyticsAccess("org", now)
    expect(access.firstFreeEventId).toBe("eight")
    // Literal: 20 Aug 22:00 + 90 days.
    expect(access.freeUntil).toEqual(new Date("2026-11-18T22:00:00Z"))
    expect(mockDb.organisations.updateMany).toHaveBeenCalledWith({
      where: { id: "org", analytics_free_until: null },
      data: { analytics_free_until: new Date("2026-11-18T22:00:00Z"), first_free_event_id: "eight" },
    })
  })

  it("keeps a window already written, whatever that night's count, and never re-derives it", async () => {
    mockDb.organisations.findUnique.mockResolvedValue({ analytics_free_until: new Date("2026-12-01T00:00:00Z"), first_free_event_id: "six" })
    const access = await analyticsAccess("org", now)
    expect(access).toMatchObject({ freeUntil: new Date("2026-12-01T00:00:00Z"), firstFreeEventId: "six", reason: "free_window" })
    expect(mockDb.events.findMany).not.toHaveBeenCalled()
    expect(mockDb.organisations.updateMany).not.toHaveBeenCalled()
  })

  it("has not started while every night had fewer than 8", async () => {
    mockCounts.mockResolvedValue(new Map([["seven", 7], ["eight", 7]]))
    const access = await analyticsAccess("org", now)
    expect(access).toMatchObject({ freeUntil: null, firstFreeEventId: null, org: true, reason: "free_window" })
    expect(mockDb.organisations.updateMany).not.toHaveBeenCalled()
  })
})

describe("mayOpenEvent", () => {
  const locked: AnalyticsAccess = {
    orgId: "o",
    org: false,
    reason: "free",
    freeUntil: new Date(now.getTime() - DAY),
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

describe("the floors on every new figure (C16, G9)", () => {
  it("holds a count of people under 5", () => {
    expect(held(4)).toBeNull()
    expect(held(5)).toBe(5)
  })

  it("shows a part only when the part AND the rest reach 5", () => {
    expect(heldPart(18, 20)).toBeNull() // the 2 who were not would be named
    expect(heldPart(11, 12)).toBeNull() // the 1
    expect(heldPart(12, 12)).toBeNull() // everyone
    expect(heldPart(4, 20)).toBeNull() // min cell
    expect(heldPart(6, 4)).toBeNull() // the group itself is under the floor
    expect(heldPart(7, 12)).toBe(7) // 7 and 5
    expect(heldPart(5, 10)).toBe(5)
  })
})

describe("mergeArrivals (C18)", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 14, minute))

  it("merges a quiet slot into the bar beside it, so every bar holds 5 and the bars add up", () => {
    const bars = mergeArrivals([
      { at: at(0), n: 6 },
      { at: at(10), n: 2 },
      { at: at(20), n: 4 },
      { at: at(30), n: 9 },
      { at: at(40), n: 1 },
    ])
    expect(bars.map((b) => b.people)).toEqual([6, 6, 10])
    expect(bars.every((b) => b.people >= 5)).toBe(true)
    expect(bars.reduce((n, b) => n + b.people, 0)).toBe(22)
    // The merged bar spans its slots: 14:10 to 14:30.
    expect(bars[1]).toMatchObject({ from: "2026-10-03T14:10:00.000Z", to: "2026-10-03T14:30:00.000Z" })
    // The 1-person tail joins the last bar.
    expect(bars[2].to).toBe("2026-10-03T14:50:00.000Z")
  })

  it("draws nothing at all when fewer than 5 arrived", () => {
    expect(mergeArrivals([{ at: at(0), n: 2 }, { at: at(10), n: 2 }])).toEqual([])
  })
})
