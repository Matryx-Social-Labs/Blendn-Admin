import { mobileWhen } from "@/lib/mobile-datetime"
import { closedDoorMessage } from "@/lib/checkin-messages"

const KOLKATA = "Asia/Kolkata" // UTC+5:30, no DST
const at = (iso: string) => new Date(iso)

describe("mobileWhen: day-first date, 12-hour clock without ':00'", () => {
  it("noon is '12 PM'", () => {
    expect(mobileWhen(at("2026-09-29T06:30:00Z"), KOLKATA)).toBe("Tue 29 Sep, 12 PM")
  })

  it("keeps the minutes when there are some, and no leading zero on the hour", () => {
    expect(mobileWhen(at("2026-09-29T16:00:00Z"), KOLKATA)).toBe("Tue 29 Sep, 9:30 PM")
    expect(mobileWhen(at("2026-09-29T03:35:00Z"), KOLKATA)).toBe("Tue 29 Sep, 9:05 AM")
  })

  it("midnight is '12 AM' on the new day, not '24'", () => {
    expect(mobileWhen(at("2026-09-28T18:30:00Z"), KOLKATA)).toBe("Tue 29 Sep, 12 AM")
  })

  it("uses the event's zone for the date as well as the clock", () => {
    // 21:00 UTC on the 28th is already the 29th in Kolkata.
    expect(mobileWhen(at("2026-09-28T21:00:00Z"), KOLKATA)).toBe("Tue 29 Sep, 2:30 AM")
    expect(mobileWhen(at("2026-09-28T21:00:00Z"), "UTC")).toBe("Mon 28 Sep, 9 PM")
  })

  it("falls back to UTC for a zone the runtime does not know", () => {
    expect(mobileWhen(at("2026-09-28T21:00:00Z"), "Not/AZone")).toBe("Mon 28 Sep, 9 PM")
  })
})

describe("closedDoorMessage names the next day in the same form", () => {
  it("'Day 3 starts Tue 29 Sep, 9 PM.'", () => {
    const slots = ["2026-09-27", "2026-09-28", "2026-09-29"].map((d) => ({
      startTime: at(`${d}T15:30:00Z`), // 21:00 in Kolkata
      cancelledAt: null,
    }))
    const now = at("2026-09-28T20:00:00Z")
    expect(closedDoorMessage("too_early", slots[2], slots, KOLKATA, now)).toEqual({
      message: "Day 3 starts Tue 29 Sep, 9 PM.",
      ended: false,
    })
  })
})
