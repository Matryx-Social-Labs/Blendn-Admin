import { canonicalCity, plusGateFor, plusGatedAnywhere } from "@/lib/env"

/**
 * `PLUS_GATING` (step 11, review M4/L6): cities by any of their names, the
 * day each flipped (the trial's cut-off), `*` for everywhere, and a place with
 * no city never a way round a gate.
 */
const gate = (value: string | undefined, city: string | null) => {
  if (value === undefined) delete process.env.PLUS_GATING
  else process.env.PLUS_GATING = value
  return plusGateFor(city)
}

afterEach(() => {
  delete process.env.PLUS_GATING
})

describe("plusGateFor", () => {
  it("is launch season everywhere when unset or false", () => {
    expect(gate(undefined, "Bengaluru")).toEqual({ gated: false, flippedAt: null })
    expect(gate("false", null)).toEqual({ gated: false, flippedAt: null })
    expect(plusGatedAnywhere()).toBe(false)
  })

  it("reads a city's flip day as midnight in India", () => {
    expect(gate("Bengaluru:2026-11-01", "bengaluru")).toEqual({ gated: true, flippedAt: new Date("2026-10-31T18:30:00.000Z") })
    expect(gate("Bengaluru:2026-11-01", "Mumbai")).toEqual({ gated: false, flippedAt: null })
  })

  it("knows a city by its old and local names, either way round", () => {
    expect(gate("Bangalore:2026-11-01", "Bengaluru").gated).toBe(true)
    expect(gate("Bengaluru", " BANGALORE ").gated).toBe(true)
    expect(gate("Bombay", "Mumbai").gated).toBe(true)
    expect(canonicalCity("New  Delhi")).toBe("delhi")
  })

  it("gates a place with no city whenever anything is gated, with the earliest day named", () => {
    expect(gate("Mumbai:2026-12-01,Bengaluru:2026-11-01", null)).toEqual({ gated: true, flippedAt: new Date("2026-10-31T18:30:00.000Z") })
    expect(gate("Bengaluru", "")).toEqual({ gated: true, flippedAt: null })
  })

  it("takes `*` and `true` as everywhere, a city's own day first", () => {
    expect(gate("true", "Pune")).toEqual({ gated: true, flippedAt: null })
    expect(gate("*:2027-01-01", "Pune")).toEqual({ gated: true, flippedAt: new Date("2026-12-31T18:30:00.000Z") })
    expect(gate("*:2027-01-01,Bengaluru:2026-11-01", "Bengaluru")).toEqual({ gated: true, flippedAt: new Date("2026-10-31T18:30:00.000Z") })
  })
})
