import { occurrencesForSpan } from "@/lib/occurrences"

/**
 * A night that runs past midnight still ends after it begins.
 *
 * `occurrencesForSpan` puts each middle day's clock times onto that day's date.
 * That is right for a programme running 09:00–18:00 and wrong for one running
 * 21:00–03:00: three in the morning is *earlier in the day* than nine at night,
 * so the occurrence came out ending six hours before it started.
 *
 * Found in the seeded world, not by reading the code — Design Week, Asia/
 * Kolkata, spanning 09-04 21:09 to 09-06 03:09 local:
 *
 *     occurs_on 09-04   start 09-04 15:39Z   end 09-03 21:39Z
 *
 * Three of nineteen occurrences were like that. Nothing caught it because no
 * constraint forbids it and every reader treats the pair as an interval without
 * checking that it is one — the check-in window, the live tick, the arrival
 * curve. It surfaced only when `presence_sessions` arrived with a CHECK that
 * a departure cannot precede an arrival, and the backfill refused the rows.
 */
describe("occurrencesForSpan across local midnight", () => {
  const IST = "Asia/Kolkata"

  it("never emits a day that ends before it starts", () => {
    // 09-04 21:09 IST -> 09-06 03:09 IST, the shape that produced the bug.
    const start = new Date("2026-09-04T15:39:00Z")
    const end = new Date("2026-09-06T03:09:00Z")

    const days = occurrencesForSpan(start, end, IST)

    // The control: this span must actually produce multiple days, or "none are
    // inverted" is true of an empty list.
    expect(days.length).toBeGreaterThan(1)

    const inverted = days
      .filter((d) => d.endTime <= d.startTime)
      .map((d) => `${d.occursOn.toISOString().slice(0, 10)}: ${d.startTime.toISOString()} -> ${d.endTime.toISOString()}`)

    expect({ inverted, hint: "" }).toEqual({ inverted: [], hint: "" })
  })

  it("gives each night a real duration rather than a negative one", () => {
    const start = new Date("2026-09-04T15:39:00Z")
    const end = new Date("2026-09-06T03:09:00Z")

    for (const d of occurrencesForSpan(start, end, IST)) {
      const hours = (d.endTime.getTime() - d.startTime.getTime()) / 3_600_000
      expect(hours).toBeGreaterThan(0)
      // A night, not a week: the clock-carrying logic must not add days.
      expect(hours).toBeLessThanOrEqual(24)
    }
  })

  it("still handles an ordinary daytime programme unchanged", () => {
    /*
     * The regression guard for the fix itself. Adding a day when the end looks
     * earlier must not fire for 09:00-18:00, where it never does.
     */
    const start = new Date("2026-09-04T03:30:00Z") // 09:00 IST
    const end = new Date("2026-09-06T12:30:00Z") // 18:00 IST on the 6th

    const days = occurrencesForSpan(start, end, IST)
    expect(days).toHaveLength(3)
    for (const d of days) {
      const hours = (d.endTime.getTime() - d.startTime.getTime()) / 3_600_000
      expect(hours).toBeCloseTo(9, 0)
    }
  })

  it("leaves a single-day event alone", () => {
    const start = new Date("2026-09-04T03:30:00Z")
    const end = new Date("2026-09-04T12:30:00Z")
    const days = occurrencesForSpan(start, end, IST)

    expect(days).toHaveLength(1)
    expect(days[0].startTime.getTime()).toBe(start.getTime())
    expect(days[0].endTime.getTime()).toBe(end.getTime())
  })
})
