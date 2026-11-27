import { AGE_BAND_FLOOR, ageBand, bandsShown } from "@/lib/age"

/**
 * D-030 (SCRUM-1384): before a reveal a room row carries a wide age band, and only when 3+ people who checked in at
 * that event share it. These pin the edges and the floor; `room-person-facts.itest.ts` pins the routes.
 */
describe("ageBand", () => {
  it.each([
    [17, null],
    [18, "18-24"],
    [24, "18-24"],
    [25, "25-34"],
    [34, "25-34"],
    [35, "35-44"],
    [44, "35-44"],
    [45, "45+"],
    [99, "45+"],
  ])("%p is %p", (age, band) => {
    expect(ageBand(age)).toBe(band)
  })

  it("is null when the age is unknown", () => {
    expect(ageBand(null)).toBeNull()
  })
})

describe("bandsShown", () => {
  it("shows a band only once 3 people share it", () => {
    expect(AGE_BAND_FLOOR).toBe(3)
    // 26 and 30 are one band: two people.
    expect(bandsShown([{ age: 26, people: 1 }, { age: 30, people: 1 }])).toEqual(new Set())
    // A third, at another age in the same band.
    expect(bandsShown([{ age: 26, people: 1 }, { age: 30, people: 1 }, { age: 28, people: 1 }])).toEqual(new Set(["25-34"]))
  })

  it("counts people of one age together, and never a band under 18", () => {
    expect(bandsShown([{ age: 41, people: 3 }, { age: 17, people: 5 }, { age: 50, people: 2 }])).toEqual(new Set(["35-44"]))
  })
})
