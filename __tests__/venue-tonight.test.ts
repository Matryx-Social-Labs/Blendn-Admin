import { tonightHours } from "@/lib/venue-tonight"

/**
 * C6 (home panes): tonight's opening on each venue item, from `venues.hours` in
 * the venue's own zone — the same reading the open-tonight tier uses.
 */
const IST = { timezone: "Asia/Kolkata", day_reset_hour: 6 }
// 2026-10-23 is a Friday (day 5); 20:00 IST is 14:30Z.
const FRIDAY_EVENING = new Date("2026-10-23T14:30:00Z")

describe("tonightHours", () => {
  it("answers with the row for the weekday of the venue's day, in the venue's own clock", () => {
    const hours = [
      { day: 4, open: "10:00", close: "20:00" },
      { day: 5, open: "18:00", close: "01:00" },
    ]
    expect(tonightHours({ ...IST, hours }, FRIDAY_EVENING)).toEqual({ opensAt: "18:00", closesAt: "01:00" })
  })

  it("reads Friday's row at 01:00 on Saturday: the day has not reset yet", () => {
    // 01:00 IST Saturday is 19:30Z Friday; the venue's day resets at 06:00.
    const hours = [
      { day: 5, open: "18:00", close: "02:00" },
      { day: 6, open: "12:00", close: "23:00" },
    ]
    expect(tonightHours({ ...IST, hours }, new Date("2026-10-23T19:30:00Z"))).toEqual({ opensAt: "18:00", closesAt: "02:00" })
  })

  it("answers with the later opening on a split day", () => {
    const hours = [
      { day: 5, open: "12:00", close: "15:00" },
      { day: 5, open: "19:00", close: "23:30" },
    ]
    expect(tonightHours({ ...IST, hours }, FRIDAY_EVENING)).toEqual({ opensAt: "19:00", closesAt: "23:30" })
  })

  it("is null when hours were never given, or are not the shape", () => {
    expect(tonightHours({ ...IST, hours: null }, FRIDAY_EVENING)).toBeNull()
    expect(tonightHours({ ...IST, hours: [] }, FRIDAY_EVENING)).toBeNull()
    expect(tonightHours({ ...IST, hours: [{ day: 5, open: "6pm", close: "late" }] }, FRIDAY_EVENING)).toBeNull()
  })

  it("is null when there is no row for this weekday", () => {
    expect(tonightHours({ ...IST, hours: [{ day: 2, open: "09:00", close: "17:00" }] }, FRIDAY_EVENING)).toBeNull()
  })
})
