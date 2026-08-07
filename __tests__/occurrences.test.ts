import { occurrencesForSpan, CHECK_IN_LEAD_MINUTES } from "@/lib/occurrences"

/**
 * Splitting an event's span into days.
 *
 * `event_check_ins` used to carry `UNIQUE(event_id, user_id)`, so a five-day
 * conference could hold exactly one row per attendee and the check-in route's
 * upsert overwrote Monday's timestamp with Tuesday's. "Who came on Wednesday"
 * had no answer.
 *
 * The subtle case is the club night that runs past midnight. It is **one**
 * session that happens to cross a date boundary, not two days — splitting it
 * would let the same person check in twice to the same night.
 */

const iso = (s: string) => new Date(s)
const days = (r: { occursOn: Date }[]) => r.map((x) => x.occursOn.toISOString().slice(0, 10))

describe("occurrencesForSpan", () => {
  it("gives a single-evening event exactly one day", () => {
    const out = occurrencesForSpan(
      iso("2026-09-10T15:30:00Z"), // 21:00 IST
      iso("2026-09-10T18:00:00Z"),
      "Asia/Kolkata"
    )
    expect(out).toHaveLength(1)
    expect(days(out)).toEqual(["2026-09-10"])
  })

  it("keeps a night that runs past midnight as ONE occurrence", () => {
    // 21:00 to 03:00 IST. Two calendar dates, one night out. Splitting it would
    // let someone check in again at 00:01 to the same party.
    const out = occurrencesForSpan(
      iso("2026-09-10T15:30:00Z"),
      iso("2026-09-10T21:30:00Z"),
      "Asia/Kolkata"
    )
    expect(out).toHaveLength(1)
  })

  it("splits a five-day conference into five", () => {
    const out = occurrencesForSpan(
      iso("2026-09-01T03:30:00Z"), // 09:00 IST
      iso("2026-09-05T12:30:00Z"), // 18:00 IST on the 5th
      "Asia/Kolkata"
    )
    expect(out).toHaveLength(5)
    expect(days(out)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ])
  })

  it("keeps the real start and end on the first and last days", () => {
    const start = iso("2026-09-01T03:30:00Z")
    const end = iso("2026-09-05T12:30:00Z")
    const out = occurrencesForSpan(start, end, "Asia/Kolkata")
    expect(out[0].startTime.toISOString()).toBe(start.toISOString())
    expect(out[4].endTime.toISOString()).toBe(end.toISOString())
  })

  it("gives the middle days the same clock as the first", () => {
    // A conference programme runs 09:00–18:00 every day, not 09:00 on day one
    // and midnight-to-midnight thereafter.
    const out = occurrencesForSpan(
      iso("2026-09-01T03:30:00Z"),
      iso("2026-09-05T12:30:00Z"),
      "Asia/Kolkata"
    )
    const middle = out[2]
    const hourIst = (d: Date) =>
      Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          hour12: false,
        }).format(d)
      )
    expect(hourIst(middle.startTime)).toBe(9)
    expect(hourIst(middle.endTime)).toBe(18)
  })

  it("splits on the event's timezone, not the server's", () => {
    // 20:00 UTC on the 1st is already the 2nd in Tokyo. Getting this wrong puts
    // attendance on the wrong day for every Asian event.
    const out = occurrencesForSpan(
      iso("2026-09-01T20:00:00Z"),
      iso("2026-09-03T02:00:00Z"),
      "Asia/Tokyo"
    )
    expect(days(out)[0]).toBe("2026-09-02")
  })

  it("handles a two-day span that is only just over 24 hours", () => {
    // 25 hours is genuinely two sessions, unlike the 6-hour club night.
    const out = occurrencesForSpan(
      iso("2026-09-01T09:00:00Z"),
      iso("2026-09-02T10:00:00Z"),
      "UTC"
    )
    expect(out.length).toBeGreaterThan(1)
  })

  it("never produces a day whose end precedes its start", () => {
    const out = occurrencesForSpan(
      iso("2026-09-01T03:30:00Z"),
      iso("2026-09-05T12:30:00Z"),
      "Asia/Kolkata"
    )
    for (const day of out) {
      expect(day.endTime.getTime()).toBeGreaterThan(day.startTime.getTime())
    }
  })
})

describe("check-in lead time", () => {
  it("opens the doors before the programme starts", () => {
    // Attendees arrive before the first talk. Zero lead would reject everyone
    // in the queue.
    expect(CHECK_IN_LEAD_MINUTES).toBeGreaterThan(0)
    expect(CHECK_IN_LEAD_MINUTES).toBeLessThanOrEqual(180)
  })
})
