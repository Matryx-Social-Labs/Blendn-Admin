import { sharePct } from "@/lib/dashboard-format"

describe("sharePct", () => {
  it("is 0, not NaN, when nothing has been published at all", () => {
    // The branch no integration test can reach: a seeded database always has
    // somebody who published something.
    expect(sharePct(0, 0)).toBe(0)
    expect(Number.isNaN(sharePct(0, 0))).toBe(false)
  })

  it("rounds a share of the whole", () => {
    expect(sharePct(3, 7)).toBe(43)
    expect(sharePct(7, 7)).toBe(100)
    expect(sharePct(0, 7)).toBe(0)
  })
})
