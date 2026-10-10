import { execFileSync } from "child_process"
import { join } from "path"

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
