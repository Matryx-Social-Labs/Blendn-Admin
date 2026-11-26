import { readFileSync } from "fs"
import { join } from "path"

import { nextLocalTime, wallClockToUtc } from "@/lib/event-wall-clock"

/*
 * A time typed on an event form is wall-clock time where the event happens
 * (SCRUM-453). The curate form read it with `new Date(value)` -- the admin's
 * browser zone -- so once the timezone could be changed, an admin in Berlin
 * who typed 18:00 for a Bengaluru event stored 16:00Z, which attendees saw as
 * 21:30 IST. Found on staging, fixture c1a8ab7e (timezone Asia/Kolkata,
 * start 16:00Z). The organiser editor already converted in the event's zone.
 */
describe("wallClockToUtc", () => {
  it("reads the time in the event's timezone, not the machine's", () => {
    expect(wallClockToUtc("2026-10-10T18:00", "Asia/Kolkata")).toBe("2026-10-10T12:30:00.000Z")
    expect(wallClockToUtc("2026-10-10T18:00", "Europe/Berlin")).toBe("2026-10-10T16:00:00.000Z")
  })
})

/*
 * The first `hour:00` on the zone's own clock strictly after a moment: "Rate
 * the night" at 10:00 the morning after (SCRUM-1274), and quiet hours and the
 * host's morning mail after it. Two zones, and Toronto both ways across DST,
 * because a fixed offset passes every Indian case and is wrong in Canada.
 */
describe("nextLocalTime", () => {
  const at = (iso: string) => new Date(iso)

  it("a night that ends at 01:00 IST is asked at 10:00 IST the same day", () => {
    // 2026-11-29 01:00 IST
    expect(nextLocalTime(at("2026-11-28T19:30:00Z"), "Asia/Kolkata", 10)).toEqual(at("2026-11-29T04:30:00Z"))
  })

  it("an evening that ends at 18:00 IST is asked at 10:00 IST the next day", () => {
    expect(nextLocalTime(at("2026-11-28T12:30:00Z"), "Asia/Kolkata", 10)).toEqual(at("2026-11-29T04:30:00Z"))
  })

  it("is strictly after: ending at 10:00 exactly waits a day", () => {
    expect(nextLocalTime(at("2026-11-29T04:30:00Z"), "Asia/Kolkata", 10)).toEqual(at("2026-11-30T04:30:00Z"))
  })

  it("Toronto, the night the clocks go back: 10:00 EST, not 10:00 EDT", () => {
    // Sat 2026-10-31 23:00 EDT; DST ends Sun 2026-11-01 02:00.
    expect(nextLocalTime(at("2026-11-01T03:00:00Z"), "America/Toronto", 10)).toEqual(at("2026-11-01T15:00:00Z"))
  })

  it("Toronto, the night the clocks go forward: 10:00 EDT, not 10:00 EST", () => {
    // Sat 2026-03-07 23:00 EST; DST starts Sun 2026-03-08 02:00.
    expect(nextLocalTime(at("2026-03-08T04:00:00Z"), "America/Toronto", 10)).toEqual(at("2026-03-08T14:00:00Z"))
  })

  it("a zone the runtime does not know reads as UTC, as the event's pages do (eventClock)", () => {
    expect(nextLocalTime(at("2026-11-28T19:30:00Z"), "Not/AZone", 10)).toEqual(at("2026-11-29T10:00:00Z"))
  })
})

describe("the event forms", () => {
  const source = (p: string) => readFileSync(join(__dirname, "..", p), "utf8")

  it.each(["app/dashboard/events/curate/curate-form.tsx", "components/event-editor.tsx"])(
    "%s converts its times with wallClockToUtc and the event's timezone",
    (file) => {
      const src = source(file)
      expect(src).toContain("wallClockToUtc(")
      expect(src).not.toMatch(/new Date\(values\.(start|end)_time\)\.toISOString\(\)/)
    }
  )
})
