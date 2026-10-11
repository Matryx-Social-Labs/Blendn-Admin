/**
 * Step 12 units: what a venue is shown of an offer, the weekly quota, and
 * the door pass's code (RG-U02, RG-U03; the database half is
 * integration/regulars.itest.ts).
 *
 * Literals, never the constants under test: a floor of 3 or a quota of 5
 * written into the module must fail here.
 */
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "unit-nextauth-secret-0123456789abcdefghij"

jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/entitlements", () => ({ hasEntitlement: jest.fn() }))

import { codeMatches, currentPass, normaliseCode, passCode, passStep, PASS_STEP_MS } from "@/lib/offers/pass-code"
import { nextOfferAt, offerCounts } from "@/lib/offers/venue"

describe("an offer's counts, as the venue sees them", () => {
  it("shows a part only when it and the rest of its group both reach 5", () => {
    expect(offerCounts(20, 12, 6)).toEqual({ sent: 20, opened: 12, redeemed: 6 })
    // 12 of 12 opened: "everyone" names everyone it was sent to.
    expect(offerCounts(12, 12, 6).opened).toBeNull()
    // 11 of 12: the one who did not open would be named.
    expect(offerCounts(12, 11, 5).opened).toBeNull()
    // 4 opened: under the floor.
    expect(offerCounts(20, 4, 0).opened).toBeNull()
    // Opened 10, redeemed 6: the 4 who opened and did not come would be named.
    expect(offerCounts(20, 10, 6).redeemed).toBeNull()
    expect(offerCounts(20, 10, 5)).toEqual({ sent: 20, opened: 10, redeemed: 5 })
    // Nobody opened yet: zero is "everyone did not", held back too.
    expect(offerCounts(9, 0, 0)).toEqual({ sent: 9, opened: null, redeemed: null })
  })

  it("never shows a redeemed count that subtracts from what is shown into fewer than 5", () => {
    for (let sent = 5; sent <= 30; sent++) {
      for (let opened = 0; opened <= sent; opened++) {
        for (let redeemed = 0; redeemed <= opened; redeemed++) {
          const c = offerCounts(sent, opened, redeemed)
          if (c.opened !== null) expect(Math.min(c.opened, sent - c.opened)).toBeGreaterThanOrEqual(5)
          if (c.redeemed !== null) expect(Math.min(c.redeemed, opened - c.redeemed)).toBeGreaterThanOrEqual(5)
          if (c.opened !== null && c.redeemed !== null) expect(c.opened - c.redeemed).toBeGreaterThanOrEqual(5)
        }
      }
    }
  })
})

describe("two offers a week", () => {
  const at = (iso: string) => new Date(iso)
  it("has room with none or one sent this week", () => {
    expect(nextOfferAt([])).toBeNull()
    expect(nextOfferAt([at("2026-10-08T10:00:00Z")])).toBeNull()
  })

  it("names when the older of the two turns a week old", () => {
    expect(nextOfferAt([at("2026-10-08T10:00:00Z"), at("2026-10-10T10:00:00Z")])).toEqual(at("2026-10-15T10:00:00Z"))
  })
})

describe("the door pass's code", () => {
  const send = "4f8a1c2e-0000-4000-8000-000000000001"
  const now = new Date("2026-10-11T20:00:10Z")

  it("is six characters a person can read out, and turns every 30 seconds", () => {
    expect(PASS_STEP_MS).toBe(30_000)
    const { code, rotatesAt } = currentPass(send, now)
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(rotatesAt).toBe("2026-10-11T20:00:30.000Z")
    expect(currentPass(send, new Date("2026-10-11T20:00:31Z")).code).not.toBe(code)
  })

  it("matches now and the step before, never older, never another pass's", () => {
    const step = passStep(now)
    expect(codeMatches(send, passCode(send, step), now)).toBe(true)
    expect(codeMatches(send, passCode(send, step - 1), now)).toBe(true)
    // A screenshot from a minute ago.
    expect(codeMatches(send, passCode(send, step - 2), now)).toBe(false)
    expect(codeMatches(send, passCode(send, step + 1), now)).toBe(false)
    expect(codeMatches("4f8a1c2e-0000-4000-8000-000000000002", passCode(send, step), now)).toBe(false)
  })

  it("reads what staff typed as a code, or refuses it", () => {
    expect(normaliseCode(" k7q-4m2 ")).toBe("K7Q4M2")
    expect(normaliseCode("K7Q4M")).toBeNull()
    expect(normaliseCode("K7Q4M0")).toBeNull() // 0 is not on a pass
    expect(normaliseCode("K7Q4M2X")).toBeNull()
  })

  it("is not computable without the server's secret", () => {
    const code = passCode(send, 1)
    const before = process.env.NEXTAUTH_SECRET
    process.env.NEXTAUTH_SECRET = "a-different-secret-0123456789abcdefghijkl"
    try {
      expect(passCode(send, 1)).not.toBe(code)
    } finally {
      process.env.NEXTAUTH_SECRET = before
    }
  })
})
