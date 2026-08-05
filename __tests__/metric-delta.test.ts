import { percentDelta, deltaHint, tileDelta } from "@/lib/metric-delta"

/**
 * Period-over-period deltas.
 *
 * These render on the busiest screen in the product, so a wrong one is a wrong
 * number in the place an operator trusts most. The zero-baseline case is the
 * whole point: at 44 users most previous windows are empty, so the "unusual"
 * branch is the one that runs constantly.
 */

describe("percentDelta — ordinary comparisons", () => {
  it("computes growth", () => {
    expect(percentDelta(44, 40)).toBe(10)
    expect(percentDelta(120, 100)).toBe(20)
  })

  it("computes decline as a negative", () => {
    expect(percentDelta(80, 100)).toBe(-20)
  })

  it("reports no change as zero, not as null", () => {
    // Zero is a fact — "flat" — and distinct from "no baseline".
    expect(percentDelta(50, 50)).toBe(0)
  })

  it("rounds to a whole percent", () => {
    // The counts are small; a decimal implies precision the number lacks.
    expect(percentDelta(7, 3)).toBe(133)
    expect(percentDelta(1, 3)).toBe(-67)
  })

  it("handles a drop to zero", () => {
    expect(percentDelta(0, 10)).toBe(-100)
  })
})

describe("percentDelta — the zero baseline, which is the common case here", () => {
  it("returns null when there is no baseline to compare against", () => {
    // 0 → 5 is not +500% and not +∞%. There is no percentage, so we say so
    // rather than putting an invented number on the overview.
    expect(percentDelta(5, 0)).toBeNull()
  })

  it("returns null for nothing-to-nothing", () => {
    expect(percentDelta(0, 0)).toBeNull()
  })

  it("never returns Infinity or NaN", () => {
    // The bug this guards: `(5 - 0) / 0` is Infinity, and `(0 - 0) / 0` is NaN.
    // Either one renders as literal "Infinity%" or "NaN%" on screen.
    for (const [c, p] of [[5, 0], [0, 0], [-3, 0]] as const) {
      const d = percentDelta(c, p)
      expect(d === null || Number.isFinite(d)).toBe(true)
    }
  })

  it("returns null rather than propagating a non-finite input", () => {
    expect(percentDelta(NaN, 10)).toBeNull()
    expect(percentDelta(10, NaN)).toBeNull()
    expect(percentDelta(Infinity, 10)).toBeNull()
  })
})

describe("deltaHint — telling 'started' apart from 'still nothing'", () => {
  it("says 'new' when something appeared from a zero baseline", () => {
    expect(deltaHint(5, 0)).toBe("new")
  })

  it("says nothing when there was nothing and still is", () => {
    expect(deltaHint(0, 0)).toBeUndefined()
  })

  it("says nothing when a real percentage exists", () => {
    // Otherwise the tile shows a percentage AND a hint, which is noise.
    expect(deltaHint(44, 40)).toBeUndefined()
  })
})

describe("tileDelta — what the overview actually passes to MetricTile", () => {
  it("gives a delta for a normal comparison and no hint", () => {
    expect(tileDelta({ current: 44, previous: 40 })).toEqual({ delta: 10 })
  })

  it("gives a hint and no delta when growth came from nothing", () => {
    expect(tileDelta({ current: 5, previous: 0 })).toEqual({ hint: "new" })
  })

  it("gives neither when nothing has happened", () => {
    // MetricTile omits the badge entirely rather than rendering an empty one.
    expect(tileDelta({ current: 0, previous: 0 })).toEqual({})
  })

  it("never emits a delta key holding null", () => {
    // `delta={null}` would be passed through to the badge as a value, where
    // `delta === undefined` is the check that hides it.
    const result = tileDelta({ current: 5, previous: 0 })
    expect("delta" in result).toBe(false)
  })

  it("keeps a flat zero visible", () => {
    expect(tileDelta({ current: 50, previous: 50 })).toEqual({ delta: 0 })
  })
})
