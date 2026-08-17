import {
  discloseBreakdown,
  discloseFigure,
  suppressedLabel,
} from "@/lib/disclosure"
import { SPONSORSHIP } from "@/lib/constants"

/**
 * Disclosure control, tested as an attacker rather than as a user.
 *
 * Every case here is "given what IS published, can the hidden number be
 * recovered". A per-cell floor passes a naive test suite and leaks in all three
 * of the ways below.
 */

const FLOOR = SPONSORSHIP.MIN_REPORTABLE

describe("rule 1 — cells below the floor are withheld", () => {
  it("hides a small option and keeps the large ones", () => {
    const { cells } = discloseBreakdown([98, 41, 3])
    expect(cells[2]).toBeNull()
    expect(cells[0]).toBe(98)
    expect(cells[1]).toBe(41)
  })

  it("publishes everything when every cell clears the floor", () => {
    const r = discloseBreakdown([10, 9, 8])
    expect(r.cells).toEqual([10, 9, 8])
    expect(r.total).toBe(27)
    expect(r.suppressed).toBe(false)
  })

  it("treats exactly the floor as reportable", () => {
    const r = discloseBreakdown([FLOOR, FLOOR])
    expect(r.cells).toEqual([FLOOR, FLOOR])
  })

  it("treats one below the floor as not reportable", () => {
    const r = discloseBreakdown([FLOOR - 1, 40])
    expect(r.cells[0]).toBeNull()
  })
})

describe("rule 2 — the total goes when any cell goes", () => {
  it("withholds the total, because it is the complement", () => {
    // 142 - 98 - 41 = 3. Publishing the total hands back the hidden cell.
    const r = discloseBreakdown([98, 41, 3])
    expect(r.total).toBeNull()
    expect(r.suppressed).toBe(true)
  })
})

describe("rule 3 — a lone survivor is itself a leak", () => {
  it("withholds the last visible cell when everything else is hidden", () => {
    /*
     * [42, 3]: hiding only the 3 leaves 42 published. Anyone who knows the
     * poll had two options and can see 42 knows the rest — and in a room they
     * are standing in, the total is often observable.
     */
    const r = discloseBreakdown([42, 3])
    expect(r.cells).toEqual([null, null])
    expect(r.total).toBeNull()
  })

  it("does not fire on a single-option group, which has no complement", () => {
    // One cell, nothing to subtract from. If it clears the floor it stands.
    const r = discloseBreakdown([40])
    expect(r.cells).toEqual([40])
    expect(r.total).toBe(40)
  })

  it("still publishes when two or more survive", () => {
    const r = discloseBreakdown([40, 30, 2])
    expect(r.cells[0]).toBe(40)
    expect(r.cells[1]).toBe(30)
    expect(r.cells[2]).toBeNull()
  })
})

describe("rule 4 — suppression is sticky", () => {
  it("stays hidden after the numbers grow", () => {
    /*
     * A campaign reported "fewer than 5" at event end. It later reaches 7.
     * Republishing it retroactively reveals that the earlier figure was in
     * [1, 4] — the suppression itself becomes the signal.
     */
    const r = discloseBreakdown([7, 9], true)
    expect(r.cells).toEqual([null, null])
    expect(r.total).toBeNull()
    expect(r.suppressed).toBe(true)
  })

  it("applies to single figures too", () => {
    expect(discloseFigure(40, true)).toBeNull()
  })
})

describe("single figures", () => {
  it("withholds below the floor and publishes at or above it", () => {
    expect(discloseFigure(FLOOR - 1)).toBeNull()
    expect(discloseFigure(FLOOR)).toBe(FLOOR)
  })

  it("withholds zero rather than publishing it", () => {
    // Zero is below the floor, and "0 people saw this" is a disclosure about a
    // very small room as surely as "2" is.
    expect(discloseFigure(0)).toBeNull()
  })
})

describe("the copy never implies zero", () => {
  it("says fewer-than, not none", () => {
    // "0 people" and "fewer than 5 people" are different claims and only one is
    // true. Getting this wrong understates a sponsor's reach to their face.
    expect(suppressedLabel("figure")).toContain(`Fewer than ${FLOOR}`)
    expect(suppressedLabel("figure")).not.toMatch(/\b0\b|zero|none/i)
    expect(suppressedLabel("poll")).not.toMatch(/\b0\b|zero|none/i)
  })
})

describe("the property that matters: nothing is recoverable", () => {
  /**
   * For any published output, the hidden cells must not be derivable.
   *
   * Exhaustive over small groups rather than spot-checked, because the leak is
   * arithmetic and arithmetic has no interesting cases — only boundaries, and
   * this covers all of them below 8.
   */
  it("never publishes a total alongside a suppressed cell", () => {
    for (let a = 0; a < 8; a++) {
      for (let b = 0; b < 8; b++) {
        for (let c = 0; c < 8; c++) {
          const r = discloseBreakdown([a, b, c])
          const hidden = r.cells.filter((x) => x === null).length
          if (hidden > 0) expect(r.total).toBeNull()
        }
      }
    }
  })

  it("never leaves exactly one cell visible in a multi-cell group", () => {
    for (let a = 0; a < 8; a++) {
      for (let b = 0; b < 8; b++) {
        for (let c = 0; c < 8; c++) {
          const r = discloseBreakdown([a, b, c])
          expect(r.cells.filter((x) => x !== null).length).not.toBe(1)
        }
      }
    }
  })
})
