import { readFileSync } from "fs"
import { join } from "path"

import { wallClockToUtc } from "@/lib/event-wall-clock"

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
