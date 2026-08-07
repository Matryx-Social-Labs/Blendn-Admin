import { rsvpPlacement, seatsFree } from "@/lib/waitlist"

jest.mock("@/lib/db", () => ({ db: {} }))

/**
 * Where an RSVP lands, and how many seats a promotion may fill.
 *
 * The pure half. Everything that can go wrong here is an off-by-one at the
 * boundary — the difference between "full" and "one short" is one person being
 * told they cannot come.
 */

describe("placement", () => {
  it("waitlists only once the event is actually full", () => {
    // The boundary is "at or past", not "past": the 100th seat of 100 is taken.
    expect(rsvpPlacement(99, 100)).toBe("going")
    expect(rsvpPlacement(100, 100)).toBe("waitlisted")
    expect(rsvpPlacement(101, 100)).toBe("waitlisted")
  })

  it("never waitlists an event with no stated capacity", () => {
    // Inventing a limit would refuse people on a number nobody chose.
    expect(rsvpPlacement(5000, null)).toBe("going")
  })

  it("treats a capacity of zero as unstated", () => {
    // 0 in the column means "not set", not "nobody may come".
    expect(rsvpPlacement(1, 0)).toBe("going")
  })
})

describe("seats free", () => {
  it("counts the gap", () => {
    expect(seatsFree(90, 100)).toBe(10)
    expect(seatsFree(100, 100)).toBe(0)
  })

  it("never goes negative when an event is over-subscribed", () => {
    // Capacity can be lowered after people have already said yes. A negative
    // here would become a negative `take:` and throw.
    expect(seatsFree(120, 100)).toBe(0)
  })

  it("promotes nobody when there is no capacity to promote into", () => {
    expect(seatsFree(10, null)).toBe(0)
    expect(seatsFree(10, 0)).toBe(0)
  })
})
