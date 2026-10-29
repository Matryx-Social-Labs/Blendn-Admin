/**
 * Step 12 units: what a venue is shown of its offers (bands, weekly totals),
 * the weekly quota, and the door pass's code (RG-U02, RG-U03; the database half is
 * integration/regulars.itest.ts).
 *
 * Literals, never the constants under test: a floor of 3 or a quota of 5
 * written into the module must fail here.
 */
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "unit-nextauth-secret-0123456789abcdefghij"

jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/entitlements", () => ({ hasEntitlement: jest.fn() }))

import { BAD_CODE_SHAPE, codeMatches, currentPass, normaliseCode, passCode, passStep, PASS_STEP_MS } from "@/lib/offers/pass-code"
import { audienceBand, nextOfferAt, publishedTotals, weekBoundaries, weekStart, type OfferHistory } from "@/lib/offers/venue"

const D = (iso: string) => new Date(iso)
/** One offer: created at, audience, and its cumulative opens / redemptions before each boundary. */
const offer = (createdAt: string, sent: number, opened: number[], redeemed: number[]): OfferHistory => ({
  createdAt: D(createdAt),
  sent,
  opened,
  redeemed,
})

describe("how many an offer reached, as a venue is told it (M4)", () => {
  it("is a band, never the number, and nothing under 5", () => {
    expect([4, 5, 9, 10, 24, 25, 49, 50, 400].map(audienceBand)).toEqual([null, "5–9", "5–9", "10–24", "10–24", "25–49", "25–49", "50+", "50+"])
  })
})

describe("the venue's week", () => {
  it("starts at the venue-day start of Monday, on its own clock", () => {
    // Sun 11 Oct 2026, 23:00 IST is still the week of Mon 5 Oct; 06:00 IST = 00:30 UTC.
    expect(weekStart("Asia/Kolkata", 6, D("2026-10-11T17:30:00Z")).toISOString()).toBe("2026-10-05T00:30:00.000Z")
    // Mon 12 Oct 05:00 IST is before the reset: still last week.
    expect(weekStart("Asia/Kolkata", 6, D("2026-10-11T23:30:00Z")).toISOString()).toBe("2026-10-05T00:30:00.000Z")
    expect(weekStart("Asia/Kolkata", 6, D("2026-10-12T01:00:00Z")).toISOString()).toBe("2026-10-12T00:30:00.000Z")
  })

  it("lists the week starts after the first offer up to this week's", () => {
    const b = weekBoundaries("UTC", 6, D("2026-09-23T12:00:00Z"), D("2026-10-14T12:00:00Z"))
    expect(b.map((x) => x.toISOString())).toEqual(["2026-09-28T06:00:00.000Z", "2026-10-05T06:00:00.000Z", "2026-10-12T06:00:00.000Z"])
  })
})

describe("weekly totals that cannot be differenced (M1)", () => {
  const weeks = [D("2026-09-28T06:00:00Z"), D("2026-10-05T06:00:00Z"), D("2026-10-12T06:00:00Z")]

  it("the review's probe: two offers, one a week — the second week alone (15 sent, 11 opened) is never published", () => {
    const A = offer("2026-09-23T12:00:00Z", 20, [10, 10, 10], [0, 0, 0])
    const B = offer("2026-09-30T12:00:00Z", 15, [0, 11, 11], [0, 0, 0])
    const t = publishedTotals(weeks, [A, B])
    // Week 1 (A alone, 10 of 20) published; week 2 adds B's 11 of 15 — the 4 who did not open would be named — held.
    expect(t).toEqual({ asOf: "2026-09-28T06:00:00.000Z", sent: "10–24", opened: 10, redeemed: null })
  })

  it("rolls a held week's change into the next one that is safe", () => {
    const A = offer("2026-09-23T12:00:00Z", 20, [10, 10, 10], [0, 0, 0])
    const B = offer("2026-09-30T12:00:00Z", 15, [0, 11, 11], [0, 0, 0])
    const C = offer("2026-10-07T12:00:00Z", 30, [0, 0, 10], [0, 0, 0])
    // Since week 1: 45 more sent, 21 more opened, 24 not — both at the floor; C alone, 10 of 30, too.
    expect(publishedTotals(weeks, [A, B, C])).toEqual({ asOf: "2026-10-12T06:00:00.000Z", sent: "50+", opened: 31, redeemed: null })
  })

  it("holds a week whose only offer fails the rule on its own, even inside a large total", () => {
    const A = offer("2026-09-23T12:00:00Z", 40, [20, 20, 20], [5, 5, 5])
    const B = offer("2026-10-07T12:00:00Z", 7, [0, 0, 7], [0, 0, 0])
    const C = offer("2026-10-08T12:00:00Z", 30, [0, 0, 10], [0, 0, 0])
    // Week 2 changed nothing and stands. Week 3's change (37 sent, 17 opened, 20 not) would pass,
    // but B in it is 7 of 7 — everyone opened — so the week is held.
    expect(publishedTotals(weeks, [A, B, C])).toEqual({ asOf: "2026-10-05T06:00:00.000Z", sent: "25–49", opened: 20, redeemed: 5 })
  })

  it("never publishes two weeks whose difference names fewer than 5 (an exhaustive sweep)", () => {
    // Every combination of opens for a 3-week history of two offers: whatever is published,
    // the step between consecutive published weeks is zero or passes the complement rule.
    const sizes = [5, 8, 12, 20]
    for (const sa of sizes) for (const sb of sizes) {
      for (let a1 = 0; a1 <= sa; a1 += 3) for (let b2 = 0; b2 <= sb; b2 += 3) {
        const A = offer("2026-09-23T12:00:00Z", sa, [a1, Math.min(sa, a1 + 1), Math.min(sa, a1 + 2)], [0, 0, 0])
        const B = offer("2026-09-30T12:00:00Z", sb, [0, b2, b2], [0, 0, 0])
        const seen: { s: number; o: number }[] = [{ s: 0, o: 0 }]
        for (let k = 1; k <= weeks.length; k++) {
          const t = publishedTotals(weeks.slice(0, k), [A, B])
          if (!t.asOf) continue
          const i = weeks.findIndex((w) => w.toISOString() === t.asOf)
          const s = [A, B].filter((o) => o.createdAt < weeks[i]).reduce((n, o) => n + o.sent, 0)
          const o = [A, B].filter((x) => x.createdAt < weeks[i]).reduce((n, x) => n + x.opened[i], 0)
          const last = seen[seen.length - 1]
          if (s !== last.s || o !== last.o) {
            const dS = s - last.s
            const dO = o - last.o
            if (!(dS === 0 && dO === 0)) {
              expect(Math.min(dO, dS - dO)).toBeGreaterThanOrEqual(5)
            }
            seen.push({ s, o })
          }
        }
      }
    }
  })

  it("shows nothing before a week is published", () => {
    expect(publishedTotals([], [])).toEqual({ asOf: null, sent: null, opened: null, redeemed: null })
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
    // SCRUM-899: the sentence for a refused shape names the characters that cannot be on a pass.
    expect(normaliseCode("A1B2C3")).toBeNull()
    expect(BAD_CODE_SHAPE).toMatch(/0, 1, I or O/)
    for (const c of "01IO") expect(normaliseCode(`K7Q4M${c}`)).toBeNull()
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
