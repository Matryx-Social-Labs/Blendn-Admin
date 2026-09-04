import { occupancyMostlyInferred, MOSTLY_INFERRED_SHARE } from "@/lib/live-metrics"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * The room says when it is guessing.
 *
 * Sessions close on a decision — a checkout, the sweeper applying the client's
 * tested departure policy, the occurrence ending — and never on silence,
 * because the Expo client polls in the foreground only and a pocketed phone
 * goes quiet within minutes. Emptying a room on that would be the old bug
 * (occupancy that only climbs) inverted into the more dangerous direction.
 *
 * The cost of that choice is a figure that drifts upward if the sweeper
 * stalls. The price of keeping real people in the room is saying plainly when
 * most of the count is inference, which is what R31 asks for: a number nobody
 * can trust should say so where it is shown.
 */
describe("occupancy says when it is mostly inferred", () => {
  it("has a threshold to compare against", () => {
    // The control: an undefined share makes every comparison below NaN, and
    // every assertion passes vacuously.
    expect(typeof MOSTLY_INFERRED_SHARE).toBe("number")
    expect(MOSTLY_INFERRED_SHARE).toBeGreaterThan(0)
    expect(MOSTLY_INFERRED_SHARE).toBeLessThan(1)
  })

  it("is confident when most of the room has been seen", () => {
    expect(occupancyMostlyInferred({ inside: 100, staleInside: 10 })).toBe(false)
    expect(occupancyMostlyInferred({ inside: 100, staleInside: 50 })).toBe(false)
  })

  it("admits inference when most of the room has not", () => {
    expect(occupancyMostlyInferred({ inside: 100, staleInside: 51 })).toBe(true)
    expect(occupancyMostlyInferred({ inside: 3, staleInside: 3 })).toBe(true)
  })

  it("does not call an empty room unreliable", () => {
    /*
     * Nobody inside is a fact, not a guess. Badging it "roughly" would put a
     * warning on the most certain number the screen ever shows — and it is the
     * state every event is in before doors.
     */
    expect(occupancyMostlyInferred({ inside: 0, staleInside: 0 })).toBe(false)
  })

  it("is actually wired to the screen", () => {
    /*
     * The prop existed for weeks with no caller: it was added for the
     * mass-checkout guard, #278 deleted the guard, and the affordance outlived
     * its cause. A rule that is computed and never rendered is the shape of
     * defect this codebase keeps finding, so the wiring is asserted rather
     * than assumed.
     */
    const tab = readFileSync(
      join(__dirname, "..", "components", "dashboard", "live-tab.tsx"),
      "utf8"
    )
    expect(tab).toMatch(/unreliable=\{occupancyMostlyInferred\(snapshot\)\}/)
  })
})
