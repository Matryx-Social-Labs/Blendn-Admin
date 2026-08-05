import {
  resolveRange,
  previousRange,
  rangeLabel,
  rangeToParams,
  parseISODate,
  toISODate,
  DEFAULT_RANGE,
} from "@/lib/date-range"

/**
 * The global date range.
 *
 * Every chart and table on a page reads this, so a bug here is not a broken
 * control — it is every number on screen being quietly wrong for a window
 * nobody chose. The failure is silent, which is why it is asserted rather than
 * eyeballed.
 */

// A fixed "now" so nothing here depends on when the suite runs.
const NOW = new Date(2026, 7, 5, 14, 30) // 5 Aug 2026, 14:30 local
const DAY = 24 * 60 * 60 * 1000

describe("resolveRange — presets", () => {
  it("defaults to 30d when nothing is in the URL", () => {
    const r = resolveRange({}, NOW)
    expect(r.key).toBe(DEFAULT_RANGE)
    expect(r.to).toEqual(NOW)
  })

  it("starts each preset at midnight, not at this time of day", () => {
    // Otherwise "7d" is 7 days and 14.5 hours, and two page loads an hour apart
    // return different numbers for the same window.
    const r = resolveRange({ range: "7d" }, NOW)
    expect(r.from.getHours()).toBe(0)
    expect(r.from.getMinutes()).toBe(0)
    expect(r.from.getSeconds()).toBe(0)
  })

  it("spans the right number of days", () => {
    for (const [key, days] of [["7d", 7], ["30d", 30], ["90d", 90]] as const) {
      const r = resolveRange({ range: key }, NOW)
      const spanDays = Math.round((NOW.getTime() - r.from.getTime()) / DAY)
      // NOW is mid-afternoon and `from` is midnight, so the span rounds to days.
      expect(spanDays).toBe(days)
    }
  })

  it("today runs from this morning to now", () => {
    const r = resolveRange({ range: "today" }, NOW)
    expect(toISODate(r.from)).toBe("2026-08-05")
    expect(r.from.getHours()).toBe(0)
    expect(r.to).toEqual(NOW)
  })
})

describe("resolveRange — never throws on a hand-edited URL", () => {
  it("falls back to the default for an unknown range", () => {
    // A dashboard that 500s because someone typed ?range=lol is worse than one
    // that shows the default window.
    expect(resolveRange({ range: "lol" }, NOW).key).toBe(DEFAULT_RANGE)
    expect(resolveRange({ range: "" }, NOW).key).toBe(DEFAULT_RANGE)
  })

  it("falls back when custom is missing its dates", () => {
    expect(resolveRange({ range: "custom" }, NOW).key).toBe(DEFAULT_RANGE)
    expect(resolveRange({ range: "custom", from: "2026-01-01" }, NOW).key).toBe(DEFAULT_RANGE)
  })

  it("falls back when custom dates are unparseable", () => {
    expect(resolveRange({ range: "custom", from: "nope", to: "2026-01-05" }, NOW).key).toBe(
      DEFAULT_RANGE
    )
  })
})

describe("resolveRange — custom", () => {
  it("includes the whole of the last selected day", () => {
    // `to` is exclusive. Without the +1 day, "Jan 5 → Jan 5" is an empty window
    // and a single-day selection shows nothing at all.
    const r = resolveRange({ range: "custom", from: "2026-01-05", to: "2026-01-05" }, NOW)
    expect(r.key).toBe("custom")
    expect(toISODate(r.from)).toBe("2026-01-05")
    expect(r.to.getTime() - r.from.getTime()).toBe(DAY)
  })

  it("swaps a backwards range rather than refusing it", () => {
    // Dragging right-to-left is a normal gesture.
    const r = resolveRange({ range: "custom", from: "2026-03-10", to: "2026-03-01" }, NOW)
    expect(toISODate(r.from)).toBe("2026-03-01")
    expect(toISODate(new Date(r.to.getTime() - DAY))).toBe("2026-03-10")
  })
})

describe("parseISODate", () => {
  it("parses a real date to local midnight", () => {
    const d = parseISODate("2026-08-05")!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(7)
    expect(d.getDate()).toBe(5)
    expect(d.getHours()).toBe(0)
  })

  it("rejects a date that does not exist", () => {
    // `new Date(2026, 1, 31)` silently rolls forward to March 3rd, so a naive
    // parser accepts 31 February and shows a window nobody asked for.
    expect(parseISODate("2026-02-31")).toBeNull()
    expect(parseISODate("2026-13-01")).toBeNull()
    expect(parseISODate("2025-02-29")).toBeNull() // not a leap year
  })

  it("accepts a real leap day", () => {
    expect(parseISODate("2028-02-29")).not.toBeNull()
  })

  it("rejects anything not YYYY-MM-DD", () => {
    for (const bad of ["", "05-08-2026", "2026/08/05", "2026-8-5", "yesterday", null, undefined]) {
      expect(parseISODate(bad as string)).toBeNull()
    }
  })

  it("round-trips through toISODate", () => {
    expect(toISODate(parseISODate("2026-08-05")!)).toBe("2026-08-05")
  })
})

describe("previousRange — the comparison window", () => {
  it("is the same length, immediately before", () => {
    const current = resolveRange({ range: "7d" }, NOW)
    const prev = previousRange(current)
    expect(prev.to).toEqual(current.from)
    expect(prev.to.getTime() - prev.from.getTime()).toBe(
      current.to.getTime() - current.from.getTime()
    )
  })

  it("does not overlap the current window", () => {
    // An overlapping comparison double-counts the boundary and makes every
    // delta wrong in the same direction.
    const current = resolveRange({ range: "30d" }, NOW)
    const prev = previousRange(current)
    expect(prev.to.getTime()).toBeLessThanOrEqual(current.from.getTime())
  })

  it("works for a custom window too", () => {
    const current = resolveRange({ range: "custom", from: "2026-03-01", to: "2026-03-10" }, NOW)
    const prev = previousRange(current)
    expect(prev.to.getTime() - prev.from.getTime()).toBe(10 * DAY)
  })
})

describe("rangeLabel", () => {
  it("shows the preset label", () => {
    expect(rangeLabel(resolveRange({ range: "7d" }, NOW))).toBe("7d")
  })

  it("shows the inclusive last day for a custom range, not the exclusive end", () => {
    // The user picked Jan 5th; showing "Jan 6" because the end is exclusive
    // would look like an off-by-one bug to them, because it reads as one.
    const label = rangeLabel(resolveRange({ range: "custom", from: "2026-01-01", to: "2026-01-05" }, NOW))
    expect(label).toBe("2026-01-01 → 2026-01-05")
  })
})

describe("rangeToParams — keep shared URLs clean", () => {
  it("writes nothing for the default", () => {
    expect(rangeToParams(DEFAULT_RANGE).toString()).toBe("")
  })

  it("writes just the key for a non-default preset", () => {
    expect(rangeToParams("7d").toString()).toBe("range=7d")
  })

  it("writes all three for a custom range", () => {
    const p = rangeToParams("custom", { from: "2026-01-01", to: "2026-01-05" })
    expect(p.get("range")).toBe("custom")
    expect(p.get("from")).toBe("2026-01-01")
    expect(p.get("to")).toBe("2026-01-05")
  })

  it("does not write a half-filled custom range", () => {
    // Otherwise the URL says custom and resolveRange falls back, so the control
    // and the data disagree about what is on screen.
    expect(rangeToParams("custom", { from: "2026-01-01", to: "" }).toString()).toBe("")
  })

  it("round-trips through resolveRange", () => {
    for (const key of ["today", "7d", "30d", "90d"] as const) {
      const params = rangeToParams(key)
      const resolved = resolveRange({ range: params.get("range") ?? undefined }, NOW)
      expect(resolved.key).toBe(key)
    }
  })
})
