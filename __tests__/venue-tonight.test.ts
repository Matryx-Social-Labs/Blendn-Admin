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

/*
 * SCRUM-1154: what the guest is told for a week the editor allows, on a fixed
 * clock with the real Intl (no mocked zone): the Friday night at 17:00, 23:30
 * and 00:45 venue time, and a Toronto Saturday across the 2026-11-01 fall-back.
 */
describe("tonightHours for the editor's week", () => {
  const week = [
    { day: 1, open: "17:00", close: "23:00" },
    { day: 5, open: "18:00", close: "01:30" },
    { day: 6, open: "18:00", close: "02:00" },
  ]
  const friday = { opensAt: "18:00", closesAt: "01:30" }

  it.each([
    ["17:00 Friday", "2026-10-23T11:30:00Z"],
    ["23:30 Friday", "2026-10-23T18:00:00Z"],
    ["00:45 Saturday, still Friday's night", "2026-10-23T19:15:00Z"],
  ])("answers Friday's opening at %s in Bengaluru", (_label, at) => {
    expect(tonightHours({ ...IST, hours: week }, new Date(at))).toEqual(friday)
  })

  it("answers Saturday's opening from 06:00 Saturday, and nothing on a closed Sunday", () => {
    expect(tonightHours({ ...IST, hours: week }, new Date("2026-10-24T00:45:00Z"))).toEqual({ opensAt: "18:00", closesAt: "02:00" })
    expect(tonightHours({ ...IST, hours: week }, new Date("2026-10-25T06:30:00Z"))).toBeNull()
  })

  const TORONTO = { timezone: "America/Toronto", day_reset_hour: 6 }
  const saturday = { opensAt: "18:00", closesAt: "02:00" }

  it.each([
    ["23:30 EDT Saturday", "2026-11-01T03:30:00Z", saturday],
    ["01:30 EDT Sunday, before the clocks go back", "2026-11-01T05:30:00Z", saturday],
    ["01:30 EST Sunday, after they go back", "2026-11-01T06:30:00Z", saturday],
    ["05:30 EST Sunday, still Saturday's night", "2026-11-01T10:30:00Z", saturday],
    ["06:30 EST Sunday, a closed day", "2026-11-01T11:30:00Z", null],
  ])("answers in Toronto at %s", (_label, at, expected) => {
    expect(tonightHours({ ...TORONTO, hours: week }, new Date(at))).toEqual(expected)
  })
})
