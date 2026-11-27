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
    expect(occupancyMostlyInferred({ inside: 100, unconfirmed: 10 })).toBe(false)
    expect(occupancyMostlyInferred({ inside: 100, unconfirmed: 50 })).toBe(false)
  })

  it("admits inference when most of the room has not", () => {
    expect(occupancyMostlyInferred({ inside: 100, unconfirmed: 51 })).toBe(true)
    expect(occupancyMostlyInferred({ inside: 3, unconfirmed: 3 })).toBe(true)
  })

  it("does not call an empty room unreliable", () => {
    /*
     * Nobody inside is a fact, not a guess. Badging it "roughly" would put a
     * warning on the most certain number the screen ever shows — and it is the
     * state every event is in before doors.
     */
    expect(occupancyMostlyInferred({ inside: 0, unconfirmed: 0 })).toBe(false)
  })

  it("no longer greys the host's hero: the range replaced it (SCRUM-1328)", () => {
    /*
     * It turned the figure into "~52 in the room, roughly" and hid the
     * over-capacity pill: the safety signal went quiet exactly when a full
     * room's phones were in pockets. The hero shows "seen – checked in" now and
     * judges capacity on the high end. What is left of this rule fills the
     * venue payload's `mostlyInferred`, which nothing renders.
     */
    const read = (f: string) => readFileSync(join(__dirname, "..", "components", "dashboard", f), "utf8")
    for (const file of ["live-tab.tsx", "occupancy-hero.tsx"]) {
      expect(read(file)).not.toMatch(/unreliable|occupancyMostlyInferred|mostlyInferred/)
    }
  })
})
