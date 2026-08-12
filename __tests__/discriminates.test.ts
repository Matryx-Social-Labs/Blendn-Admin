import { assertDiscriminates } from "@/lib/discriminates"

/*
 * The guard exists to catch suites that cannot fail, so the thing worth testing
 * hardest is that the guard itself can fail. A version of this that returned a
 * string unconditionally would pass every caller and be worse than nothing —
 * it would put a reassuring line in the output of a broken check.
 */
describe("assertDiscriminates", () => {
  it("passes when something was accepted and something was refused", () => {
    const summary = assertDiscriminates([
      { label: "our bucket", accepted: true },
      { label: "someone else's folder", accepted: false },
      { label: "metadata endpoint", accepted: false },
    ])
    expect(summary).toBe("1 accepted, 2 refused — the check discriminates")
  })

  it("fails when every input was refused — the false-pass this exists to catch", () => {
    // The exact shape of the original SSRF matrix: seven refusals, no control,
    // and a completely absent guard would have produced the same output.
    expect(() =>
      assertDiscriminates([
        { label: "our bucket", accepted: false },
        { label: "someone else's folder", accepted: false },
        { label: "metadata endpoint", accepted: false },
      ])
    ).toThrow(/nothing was accepted/)
  })

  it("names what was refused, so the cause is diagnosable from the failure alone", () => {
    expect(() =>
      assertDiscriminates([
        { label: "our bucket", accepted: false },
        { label: "chat folder", accepted: false },
      ])
    ).toThrow(/our bucket, chat folder/)
  })

  it("fails when everything was accepted — a guard that never refuses is not running", () => {
    expect(() =>
      assertDiscriminates([
        { label: "our bucket", accepted: true },
        { label: "metadata endpoint", accepted: true },
      ])
    ).toThrow(/the guard is not running/)
  })

  it("fails on an empty set rather than vacuously passing", () => {
    // `[].every(...)` is true, and a guard built on that idiom would report
    // success for a check that never executed.
    expect(() => assertDiscriminates([])).toThrow(/did not run/)
  })
})
