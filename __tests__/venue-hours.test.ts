import { venueHours } from "@/lib/venue-hours"

describe("venueHours", () => {
  it("returns the rows when they have the documented shape", () => {
    const rows = [{ day: 5, open: "17:00", close: "01:00" }]
    expect(venueHours(rows)).toEqual(rows)
  })

  it.each([
    ["null", null],
    ["an empty list", []],
    ["an object", { monday: "late" }],
    ["a day out of range", [{ day: 7, open: "09:00", close: "17:00" }]],
    ["a clock that is not HH:MM", [{ day: 1, open: "9am", close: "17:00" }]],
    ["an extra key", [{ day: 1, open: "09:00", close: "17:00", note: "x" }]],
  ])("reads %s as not given", (_label, raw) => {
    expect(venueHours(raw)).toBeNull()
  })
})
