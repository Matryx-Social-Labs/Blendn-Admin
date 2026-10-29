import { execFileSync } from "child_process"
import { join } from "path"

import { dayInIndia, sharePct } from "@/lib/dashboard-format"

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

describe("formatDay is India's day whatever the host's zone (final review D3)", () => {
  // A child process per zone: jest's sandbox does not pass a changed TZ to Date or Intl.
  it.each([
    ["UTC", 20],
    ["America/Los_Angeles", 13],
  ])("under TZ=%s, 20:00 UTC on 9 Oct is Sat, Oct 10", (tz, hostHour) => {
    const out = execFileSync(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      ["-e", 'import { formatDay } from "./lib/dashboard-format"; console.log(JSON.stringify([formatDay("2026-10-09T20:00:00Z"), new Date("2026-10-09T20:00:00Z").getHours()]))'],
      { cwd: process.cwd(), env: { ...process.env, TZ: tz }, encoding: "utf8" }
    )
    // The host's clock really is in that zone, and the day is still India's.
    expect(JSON.parse(out)).toEqual(["Sat, Oct 10", hostHour])
  })
})

describe("dayInIndia (a grant that ends next year said only the day)", () => {
  const now = new Date("2026-10-29T12:00:00Z")
  it("leaves the year off a date in this year", () => {
    expect(dayInIndia("2026-12-31T10:00:00Z", now)).toBe("31 Dec")
  })
  it("adds the year to a date in another year", () => {
    expect(dayInIndia("2027-10-29T19:35:07Z", now)).toBe("30 Oct 2027")
    expect(dayInIndia("2025-01-02T10:00:00Z", now)).toBe("2 Jan 2025")
  })
  it("judges the year on India's calendar, not UTC's", () => {
    expect(dayInIndia("2026-12-31T20:00:00Z", now)).toBe("1 Jan 2027")
  })
})
