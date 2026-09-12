/*
 * The RSVP pacing curve — extracted from app/dashboard/actions.ts to
 * lib/pacing.ts so the benchmark (the previous event's curve) could be built
 * with the same fold, and never tested directly: the one integration test
 * that reaches it checks monotonicity of a single curve and never sets a
 * previous event.
 */
import { buildPacing, pacingWindowDays } from "@/lib/pacing"

const DAY = 24 * 60 * 60 * 1000
const start = new Date("2026-09-20T18:00:00Z")
const atFor = (from: Date, daysBefore: number) => ({ created_at: new Date(from.getTime() - daysBefore * DAY) })
const at = (daysBefore: number) => atFor(start, daysBefore)

describe("buildPacing", () => {
  it("is a cumulative count per day out, from the window down to event day", () => {
    const points = buildPacing([at(10), at(3), at(3), at(0.5)], start, 7)
    expect(points.map((p) => p.daysOut)).toEqual([7, 6, 5, 4, 3, 2, 1, 0])
    // The RSVP ten days out is in every point; the two at three days join at
    // 3; half a day out rounds up to a whole day, so it joins at 1.
    expect(points.map((p) => p.cumulative)).toEqual([1, 1, 1, 1, 3, 3, 4, 4])
  })

  it("an RSVP after the event started counts on event day, not at a negative day out", () => {
    const points = buildPacing([at(-1)], start, 3)
    expect(points[points.length - 1]).toEqual({ daysOut: 0, cumulative: 1 })
    expect(points.every((p) => p.daysOut >= 0)).toBe(true)
  })

  it("two curves built with the same window align on daysOut, whatever their lengths were before", () => {
    const current = buildPacing([at(5)], start, 14)
    const previousStart = new Date("2026-08-01T18:00:00Z")
    const previous = buildPacing([atFor(previousStart, 5), atFor(previousStart, 1)], previousStart, 14)
    const d5 = current.find((p) => p.daysOut === 5)!.cumulative
    const p5 = previous.find((p) => p.daysOut === 5)!.cumulative
    expect(d5).toBe(1)
    expect(p5).toBe(1)
    expect(previous.find((p) => p.daysOut === 0)!.cumulative).toBe(2)
  })
})

describe("pacingWindowDays", () => {
  it("shows two weeks past the event's distance, floored at a week and capped at two months", () => {
    expect(pacingWindowDays(0)).toBe(14)
    expect(pacingWindowDays(1)).toBe(15)
    expect(pacingWindowDays(-20)).toBe(7)
    expect(pacingWindowDays(90)).toBe(60)
  })
})
