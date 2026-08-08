import { MIN_RATINGS, trustBand } from "@/lib/trust"

jest.mock("@/lib/db", () => ({ db: {} }))

/**
 * The band, pinned.
 *
 * The failure that matters is not a slightly wrong average — it is a band that
 * reads as a verdict on someone with two ratings, or one where enough good
 * ratings bury a report.
 */

describe("a band needs enough ratings to be one", () => {
  it("stays unrated below the floor", () => {
    // Two people can dislike anyone. Below the floor there is no pattern to see.
    expect(trustBand(MIN_RATINGS - 1, 1)).toBe("unrated")
    expect(trustBand(MIN_RATINGS - 1, 5)).toBe("unrated")
  })

  it("bands at exactly the floor", () => {
    expect(trustBand(MIN_RATINGS, 4.5)).toBe("good")
  })

  it("is unrated when there is no average to band", () => {
    expect(trustBand(10, null)).toBe("unrated")
  })
})

describe("the boundaries", () => {
  it("splits good, mixed and poor", () => {
    expect(trustBand(10, 4.0)).toBe("good")
    expect(trustBand(10, 3.9)).toBe("mixed")
    expect(trustBand(10, 3.0)).toBe("mixed")
    expect(trustBand(10, 2.9)).toBe("poor")
  })

  it("bands the extremes without special-casing them", () => {
    expect(trustBand(10, 5)).toBe("good")
    expect(trustBand(10, 1)).toBe("poor")
  })
})
