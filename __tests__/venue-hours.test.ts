import { hoursProblems, MAX_OPENINGS_PER_DAY, venueHours, venueHoursSchema } from "@/lib/venue-hours"

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

/*
 * SCRUM-1154: the editor writes only what the readers place right. The app at
 * origin/stage (`lib/venuePage.ts` tonightOpening + venueDayState) and the
 * server's `tonightHours` read "tonight" as the rows of the venue's current day
 * (its day starts at `day_reset_hour`) and a split day as its later opening, so
 * each rule below is a value they would otherwise show wrong.
 */
describe("venueHoursSchema (the stored shape)", () => {
  it("accepts a close past midnight", () => {
    expect(venueHoursSchema.safeParse([{ day: 5, open: "18:00", close: "01:30" }]).success).toBe(true)
  })

  it.each([
    ["a bad time", [{ day: 5, open: "18:00", close: "24:00" }]],
    ["a clock without a leading zero", [{ day: 5, open: "8:00", close: "23:00" }]],
    ["day 7", [{ day: 7, open: "18:00", close: "23:00" }]],
  ])("refuses %s", (_label, rows) => {
    expect(venueHoursSchema.safeParse(rows).success).toBe(false)
  })
})

describe("hoursProblems (the editor's rules, day_reset_hour 06:00)", () => {
  const RESET = 6

  it("allows a normal week with a close past midnight, a close at the reset, and closed days", () => {
    const week = [
      { day: 2, open: "17:00", close: "23:00" },
      { day: 5, open: "18:00", close: "01:30" },
      { day: 6, open: "18:00", close: "06:00" },
      { day: 0, open: "06:00", close: "22:00" },
    ]
    expect(hoursProblems(week, RESET)).toEqual([])
  })

  it(`allows ${MAX_OPENINGS_PER_DAY} opening a day and refuses a second on the same day, naming both`, () => {
    expect(MAX_OPENINGS_PER_DAY).toBe(1)
    const split = [
      { day: 6, open: "12:00", close: "15:00" },
      { day: 6, open: "19:00", close: "02:00" },
    ]
    const problems = hoursProblems(split, RESET)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ index: 1, field: "open" })
    expect(problems[0].message).toMatch(/Saturday/)
    expect(problems[0].message).toMatch(/12:00 to 15:00/)
  })

  it("refuses an opening before the venue's day starts", () => {
    const problems = hoursProblems([{ day: 6, open: "05:00", close: "11:00" }], RESET)
    expect(problems).toEqual([{ index: 0, field: "open", message: expect.stringMatching(/Saturday.*05:00.*06:00/) }])
  })

  it("refuses a night that runs past the next day's start, naming both days", () => {
    const problems = hoursProblems([{ day: 5, open: "18:00", close: "07:00" }], RESET)
    expect(problems).toEqual([{ index: 0, field: "close", message: expect.stringMatching(/Friday.*07:00.*Saturday.*06:00/) }])
  })

  it("refuses a close at the time it opens", () => {
    const problems = hoursProblems([{ day: 0, open: "22:00", close: "22:00" }], RESET)
    expect(problems).toEqual([{ index: 0, field: "close", message: expect.stringMatching(/Sunday/) }])
  })

  it("keeps a midnight-reset venue's nights to midnight", () => {
    expect(hoursProblems([{ day: 5, open: "18:00", close: "00:00" }], 0)).toEqual([])
    expect(hoursProblems([{ day: 5, open: "18:00", close: "01:00" }], 0)).toHaveLength(1)
  })

  it("reports every row with a problem, each once", () => {
    const rows = [
      { day: 5, open: "18:00", close: "07:00" },
      { day: 0, open: "22:00", close: "22:00" },
      { day: 1, open: "17:00", close: "23:00" },
    ]
    expect(hoursProblems(rows, RESET).map((p) => p.index)).toEqual([0, 1])
  })
})
