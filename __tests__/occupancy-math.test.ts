import { occupancyFrom } from "@/lib/occupancy"

jest.mock("@/lib/db", () => ({ db: {} }))

/**
 * The arithmetic behind three numbers that used to be one.
 *
 * This function exists because the live tab and the occupancy panel each did
 * this sum by hand and disagreed: the live tab capped fill at 100% and measured
 * it against staff-inclusive occupancy, so a room at 88 guests against a stated
 * 80 read "100% — full" on one screen and "110%, 8 over" on the other. Whichever
 * number the organiser happened to be looking at was the one they believed.
 *
 * The cap is the part worth guarding hardest. It did not merely round a number
 * down — it made an over-capacity room *unrepresentable*, which is the one
 * situation the live screen exists to surface.
 */

describe("fill is measured against guests", () => {
  it("does not let staff fill the room", () => {
    // Four crew in a room of four is an empty venue, not a sold-out one.
    const o = occupancyFrom({ inside: 4, staffInside: 4, uniqueAttendance: 0, capacity: 4 })
    expect(o.guestsInside).toBe(0)
    expect(o.fillPct).toBe(0)
    expect(o.overCapacity).toBe(false)
  })

  it("still counts staff as bodies in the room", () => {
    // Fire safety counts bodies, not job titles — the two numbers are different
    // questions asked by the same person ten seconds apart.
    const o = occupancyFrom({ inside: 142, staffInside: 4, uniqueAttendance: 0, capacity: 200 })
    expect(o.inside).toBe(142)
    expect(o.guestsInside).toBe(138)
    expect(o.staffInside).toBe(4)
  })
})

describe("over capacity is representable", () => {
  it("reports past 100% rather than pinning at it", () => {
    // The regression this whole function exists to prevent.
    const o = occupancyFrom({ inside: 92, staffInside: 4, uniqueAttendance: 0, capacity: 80 })
    expect(o.fillPct).toBe(110)
    expect(o.overCapacity).toBe(true)
  })

  it("is not over when guests exactly meet capacity", () => {
    // The boundary is "more than", not "at". A full room is full, not breached.
    const o = occupancyFrom({ inside: 80, staffInside: 0, uniqueAttendance: 0, capacity: 80 })
    expect(o.fillPct).toBe(100)
    expect(o.overCapacity).toBe(false)
  })

  it("is not over when only staff push the body count past the line", () => {
    // 78 guests and 5 crew in a room of 80 is 83 bodies. The fire officer cares;
    // "over capacity" as an audience measure does not fire.
    const o = occupancyFrom({ inside: 83, staffInside: 5, uniqueAttendance: 0, capacity: 80 })
    expect(o.inside).toBe(83)
    expect(o.overCapacity).toBe(false)
  })
})

describe("no capacity is not zero capacity", () => {
  it("reports null fill when none is set", () => {
    // An event with no stated capacity has no fill to report. Defaulting to 0%
    // would draw an empty progress bar on a packed room.
    const o = occupancyFrom({ inside: 40, staffInside: 2, uniqueAttendance: 0, capacity: null })
    expect(o.fillPct).toBeNull()
    expect(o.overCapacity).toBe(false)
  })

  it("treats a stated zero as no capacity rather than dividing by it", () => {
    const o = occupancyFrom({ inside: 40, staffInside: 0, uniqueAttendance: 0, capacity: 0 })
    expect(o.fillPct).toBeNull()
    expect(o.overCapacity).toBe(false)
  })
})

describe("attendance passes through untouched", () => {
  it("is independent of who is currently in the room", () => {
    // Occupancy falls as people leave; attendance only ever goes up. Deriving
    // one from the other is the conflation that started all of this.
    const o = occupancyFrom({ inside: 3, staffInside: 1, uniqueAttendance: 120, capacity: 80 })
    expect(o.uniqueAttendance).toBe(120)
    expect(o.inside).toBe(3)
  })
})
