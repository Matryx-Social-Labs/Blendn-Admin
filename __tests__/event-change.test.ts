import { changeForResponse, changedFieldsOf, nextChange, parseChangedFrom, updateEventTracked, type TrackedEvent } from "@/lib/event-change"
import { eventDays, EVENT_DAYS_WINDOW } from "@/lib/occurrences"

const mockTx = {
  $queryRaw: jest.fn(),
  events: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
}
// Outside the transaction: anything the code does here is NOT part of the edit and would survive a rollback.
const mockDirect = { events: { update: jest.fn() }, $transaction: jest.fn(async (fn: (t: typeof mockTx) => unknown) => fn(mockTx)) }
jest.mock("@/lib/db", () => ({ get db() { return mockDirect } }))
const tx = mockTx
const direct = mockDirect

const H = 3_600_000
const T0 = new Date("2031-03-01T18:00:00Z")
const base: TrackedEvent = {
  start_time: T0,
  end_time: new Date(T0.getTime() + 3 * H),
  venue_name: "The Old Room",
  address: "1 Church St",
  status: "published",
}
const moved = (over: Partial<TrackedEvent>): TrackedEvent => ({ ...base, ...over })
const NOW = new Date("2031-02-20T10:00:00Z")

describe("nextChange", () => {
  it("writes nothing when nothing worth telling anyone moved", () => {
    expect(nextChange(null, base, moved({}), NOW)).toBeNull()
    expect(nextChange(null, base, moved({ venue_name: "The Old Room", address: null }), NOW)).not.toBeNull()
  })

  it("records a time and a venue with what they were", () => {
    const next = nextChange(null, base, moved({ start_time: new Date(T0.getTime() + H), venue_name: "New" }), NOW)
    expect(next).toEqual({
      changed_at: NOW,
      changed_from: { start_time: T0.toISOString(), venue_name: "The Old Room" },
    })
  })

  it("keeps the first value across edits and clears when everything is put back", () => {
    const first = nextChange(null, base, moved({ start_time: new Date(T0.getTime() + H) }), NOW)!
    const second = nextChange(first.changed_from, moved({ start_time: new Date(T0.getTime() + H) }), moved({ start_time: new Date(T0.getTime() + 2 * H) }), NOW)!
    expect(second.changed_from).toEqual({ start_time: T0.toISOString() })

    const back = nextChange(second.changed_from, moved({ start_time: new Date(T0.getTime() + 2 * H) }), base, NOW)
    expect(back).toEqual({ changed_at: null, changed_from: null })
  })

  it("a venue cleared to null and one that was never set are the same, as the push's own comparison", () => {
    expect(nextChange(null, moved({ address: null }), moved({ address: "" }), NOW)).toBeNull()
  })

  it("only a published event records one, and only into published or cancelled", () => {
    expect(nextChange(null, moved({ status: "draft" }), moved({ status: "draft", venue_name: "X" }), NOW)).toBeNull()
    expect(nextChange(null, moved({ status: "draft" }), moved({ status: "published", venue_name: "X" }), NOW)).toBeNull()
    // Unpublishing hides it; that is not a change anybody is told about.
    expect(nextChange(null, base, moved({ status: "draft", venue_name: "X" }), NOW)).toBeNull()
    expect(nextChange(null, base, moved({ status: "cancelled" }), NOW)).toEqual({ changed_at: NOW, changed_from: { cancelled: true } })
  })
})

describe("changedFieldsOf / changeForResponse", () => {
  const row = (changed_from: unknown, over: Partial<TrackedEvent> = {}, changed_at: Date | null = NOW) => ({
    ...base,
    ...over,
    changed_at,
    changed_from,
  })

  it("derives the fields from what is stored and the row, in the order the app lists them", () => {
    const from = { cancelled: true, venue_name: "Old", start_time: new Date(T0.getTime() - H).toISOString() }
    expect(changedFieldsOf(from, { ...base, status: "cancelled" })).toEqual(["time", "venue", "cancelled"])
  })

  it("is the empty answer for an event that has not changed", () => {
    expect(changeForResponse(row(null, {}, null))).toEqual({ changedAt: null, changedFields: [], changedFrom: null })
  })

  it("carries the old time and venue in camelCase, and only for what still differs", () => {
    const out = changeForResponse(row({ start_time: new Date(T0.getTime() - H).toISOString(), venue_name: "The Old Room" }))
    expect(out.changedFields).toEqual(["time"])
    expect(out.changedFrom).toEqual({ startTime: new Date(T0.getTime() - H).toISOString() })
  })

  it("a cancel names no old values", () => {
    expect(changeForResponse(row({ cancelled: true }, { status: "cancelled" }))).toEqual({
      changedAt: NOW,
      changedFields: ["cancelled"],
      changedFrom: null,
    })
  })

  it("trusts nothing it reads back", () => {
    expect(parseChangedFrom("x")).toEqual({})
    expect(parseChangedFrom([1])).toEqual({})
    expect(parseChangedFrom({ start_time: "not a date", venue_name: 5, cancelled: "yes" })).toEqual({})
  })
})

describe("eventDays", () => {
  const slot = (day: number, startH: number, endH: number, cancelled = false) => ({
    occurs_on: new Date(Date.UTC(2031, 2, day)),
    start_time: new Date(NOW.getTime() + startH * H),
    end_time: new Date(NOW.getTime() + endH * H),
    cancelled_at: cancelled ? NOW : null,
  })

  it("an event with no occurrence rows is one day", () => {
    const out = eventDays({ start_time: T0, end_time: new Date(T0.getTime() + 3 * H) }, NOW)
    expect(out.dayCount).toBe(1)
    expect(out.dayNumber).toBe(1)
    expect(out.days[0].date).toBe("2031-03-01")
  })

  it("numbers the day the session is on, counting a cancelled one in the strip but never as today", () => {
    const occurrences = [slot(1, -30, -27), slot(2, -2, 5), slot(3, 20, 23, true)]
    const out = eventDays({ start_time: occurrences[0].start_time, end_time: occurrences[2].end_time, occurrences }, NOW)
    expect(out.dayCount).toBe(3)
    expect(out.dayNumber).toBe(2)
    expect(out.days.map((d) => d.cancelled)).toEqual([false, false, true])
    expect(out.days.map((d) => d.cancelledAt !== null)).toEqual([false, false, true])
    expect(out.daysFrom).toBe(1)
  })

  describe("bounded (SV1)", () => {
    const run = (n: number, cancelledFrom = n) =>
      Array.from({ length: n }, (_, i) => slot(1 + i, -2 + (i - 100) * 24, 5 + (i - 100) * 24, i >= cancelledFrom))
    const of = (occurrences: ReturnType<typeof run>) => eventDays({ start_time: occurrences[0].start_time, end_time: occurrences[occurrences.length - 1].end_time, occurrences }, NOW)

    it("an ordinary run is whole", () => {
      const out = of(run(101))
      expect(out.days).toHaveLength(31)
      expect(out.dayCount).toBe(101)
    })

    it("a long run is a window starting two days before today, with the whole count and where it starts", () => {
      const out = of(run(365)) // today is the 101st day
      expect(out.dayNumber).toBe(101)
      expect(out.days).toHaveLength(EVENT_DAYS_WINDOW)
      expect(out.dayCount).toBe(365)
      expect(out.daysFrom).toBe(99)
    })

    it("clamps at the end of the run, and starts at day 1 when every day is cancelled", () => {
      const late = of(run(110))
      expect(late.daysFrom).toBe(110 - EVENT_DAYS_WINDOW + 1)
      expect(late.days).toHaveLength(EVENT_DAYS_WINDOW)
      const none = of(run(40, 0))
      expect(none.dayNumber).toBeNull()
      expect(none.daysFrom).toBe(1)
    })
  })

  it("after the last held day it reads as that day; every day cancelled is none", () => {
    const over = [slot(1, -30, -27), slot(2, -10, -5)]
    expect(eventDays({ start_time: over[0].start_time, end_time: over[1].end_time, occurrences: over }, NOW).dayNumber).toBe(2)
    const none = [slot(1, 5, 8, true)]
    expect(eventDays({ start_time: none[0].start_time, end_time: none[0].end_time, occurrences: none }, NOW).dayNumber).toBeNull()
  })
})

describe("updateEventTracked: the edit and its record are one unit", () => {
  const stored = { start_time: T0, end_time: new Date(T0.getTime() + 3 * H), venue_name: "Old", address: null, status: "published", changed_from: null }

  beforeEach(() => {
    for (const m of [tx.$queryRaw, tx.events.findUniqueOrThrow, tx.events.update, direct.events.update, direct.$transaction]) m.mockClear()
    tx.events.findUniqueOrThrow.mockResolvedValue(stored)
  })

  it("rejects when the record write fails, and writes nothing outside the transaction (so nothing survives the rollback)", async () => {
    const edited = { ...stored, venue_name: "New" }
    tx.events.update.mockResolvedValueOnce(edited).mockRejectedValueOnce(new Error("could not serialize access"))

    await expect(updateEventTracked({ where: { id: "e1" }, data: { venue_name: "New" } })).rejects.toThrow("could not serialize access")

    // Both writes went through the transaction's client, in order: the edit, then the record.
    expect(tx.events.update).toHaveBeenCalledTimes(2)
    expect(tx.events.update.mock.calls[0][0]).toEqual({ where: { id: "e1" }, data: { venue_name: "New" } })
    expect(tx.events.update.mock.calls[1][0].data).toHaveProperty("changed_from", { venue_name: "Old" })
    expect(direct.events.update).not.toHaveBeenCalled()
    expect(direct.$transaction).toHaveBeenCalledTimes(1)
  })

  it("locks the row before it reads it", async () => {
    tx.events.update.mockResolvedValue({ ...stored })
    await updateEventTracked({ where: { id: "e1" }, data: { title: "same" } })
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.events.findUniqueOrThrow.mock.invocationCallOrder[0])
    expect(tx.$queryRaw.mock.calls[0][0].join("")).toContain("FOR UPDATE")
  })

  it("an edit that moves nothing worth telling writes the edit once and no record", async () => {
    tx.events.update.mockResolvedValue({ ...stored })
    await updateEventTracked({ where: { id: "e1" }, data: { title: "same" } })
    expect(tx.events.update).toHaveBeenCalledTimes(1)
  })

  it("refuses a where with no id rather than lock nothing", async () => {
    await expect(updateEventTracked({ where: { slug: "x" }, data: {} })).rejects.toThrow("needs the event's id")
    expect(direct.$transaction).not.toHaveBeenCalled()
  })
})
