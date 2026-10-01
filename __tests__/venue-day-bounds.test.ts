import { venueDayBounds } from "@/lib/venue-day"

/**
 * PL-U01: a venue's day is counted on its own clock, never UTC's. The reset is
 * the privacy control (pseudonyms are new each day), so a day computed in UTC
 * would reset at 05:30 in Bengaluru and an hour apart across a DST change.
 */
describe("venueDayBounds", () => {
  it("puts 05:59 in yesterday and 06:00 in today, in Bengaluru", () => {
    const before = venueDayBounds("Asia/Kolkata", 6, new Date("2026-10-02T00:29:00Z")) // 05:59 IST
    const at = venueDayBounds("Asia/Kolkata", 6, new Date("2026-10-02T00:30:00Z")) // 06:00 IST
    expect(before.localDate).toBe("2026-10-01")
    expect(at.localDate).toBe("2026-10-02")
    expect(before.end).toEqual(at.start)
    expect(at.start.toISOString()).toBe("2026-10-02T00:30:00.000Z")
  })

  it("keeps both ends at 06:00 local across the end of summer time, so that day is 25 h", () => {
    // Berlin leaves CEST at 03:00 on Sunday 25 Oct 2026.
    const day = venueDayBounds("Europe/Berlin", 6, new Date("2026-10-24T22:00:00Z"))
    expect(day.localDate).toBe("2026-10-24")
    expect(day.start.toISOString()).toBe("2026-10-24T04:00:00.000Z") // 06:00 CEST
    expect(day.end.toISOString()).toBe("2026-10-25T05:00:00.000Z") // 06:00 CET
    expect(day.end.getTime() - day.start.getTime()).toBe(25 * 3_600_000)
  })

  it("honours a venue's own reset hour", () => {
    expect(venueDayBounds("Asia/Kolkata", 4, new Date("2026-10-01T22:00:00Z")).localDate).toBe("2026-10-01") // 03:30 IST
    expect(venueDayBounds("Asia/Kolkata", 4, new Date("2026-10-01T22:30:00Z")).localDate).toBe("2026-10-02") // 04:00 IST
  })

  it("refuses an hour off the clock and a zone it cannot read", () => {
    expect(() => venueDayBounds("Asia/Kolkata", 24, new Date())).toThrow(RangeError)
    expect(() => venueDayBounds("Mars/Olympus_Mons", 6, new Date())).toThrow(RangeError)
  })
})
