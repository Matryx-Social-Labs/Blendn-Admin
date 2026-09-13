import { whenLabel } from "@/lib/dashboard-format"
import { stageFill } from "@/components/dashboard/charts"
import { bulkDeleteMessage } from "@/lib/dashboard-format"

const NOW = new Date("2026-09-10T12:00:00Z")
const at = (iso: string) => new Date(iso)

/**
 * The two pure functions the events list and the loop chart render through.
 *
 * Both were written this session with no tests, and a coverage pass found a
 * real defect in the first one — which is the argument for the file.
 */
describe("whenLabel", () => {
  it("drops the year for an event in the current year", () => {
    // A list of 2026 events read on a 2026 afternoon does not need telling.
    expect(whenLabel(at("2026-09-16T08:15:00Z"), at("2026-09-16T11:15:00Z"), NOW)).toBe(
      "16 Sept, 8:15"
    )
  })

  it("keeps the year for an event in another year", () => {
    expect(whenLabel(at("2025-03-02T19:00:00Z"), at("2025-03-02T22:00:00Z"), NOW)).toContain("2025")
  })

  it("collapses a multi-day run to a range", () => {
    expect(whenLabel(at("2026-09-17T22:15:00Z"), at("2026-09-19T04:15:00Z"), NOW)).toBe(
      "17 Sept → 19 Sept"
    )
  })

  it("shows BOTH years when a run crosses new year", () => {
    /*
     * The bug a coverage pass found. The year rule was applied to the start
     * date and the end date was hardcoded without one, so a 31 Dec → 2 Jan run
     * rendered as "31 Dec → 2 Jan" — two dates a year apart, drawn as though
     * they were two days apart, on a screen an admin uses to find an event by
     * when it is.
     */
    const label = whenLabel(at("2026-12-31T22:00:00Z"), at("2027-01-02T02:00:00Z"), NOW)
    expect(label).toContain("2026")
    expect(label).toContain("2027")
  })

  it("shows the year on both halves of a same-year run that is not this year", () => {
    const label = whenLabel(at("2028-06-01T10:00:00Z"), at("2028-06-03T10:00:00Z"), NOW)
    expect(label).toBe("1 Jun 2028 → 3 Jun 2028")
  })
})

describe("stageFill", () => {
  it("walks chart-1 to chart-3 across the funnel", () => {
    /*
     * The palette rule, and the guard against the thing this function already
     * got wrong once: an earlier version handed stage 0 `--gradient-brand`,
     * giving the screen two gradient elements where `DESIGN_SYSTEM.md` allows
     * exactly one — and carried a comment claiming it did not.
     */
    expect(stageFill(0, 7)).toBe("var(--chart-1)")
    expect(stageFill(3, 7)).toBe("var(--chart-2)")
    expect(stageFill(6, 7)).toBe("var(--chart-3)")
  })

  it("never emits the brand gradient", () => {
    for (let i = 0; i < 7; i++) expect(stageFill(i, 7)).not.toContain("gradient")
  })

  it("survives a one-stage funnel", () => {
    // `count - 1` is the divisor, so a single stage would divide by zero.
    expect(stageFill(0, 1)).toBe("var(--chart-1)")
  })

  it("uses the whole ramp whatever the stage count", () => {
    for (const count of [3, 5, 7, 9]) {
      const used = new Set(Array.from({ length: count }, (_, i) => stageFill(i, count)))
      expect(used).toEqual(new Set(["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"]))
    }
  })
})

describe("bulkDeleteMessage", () => {
  it("counts what went", () => {
    expect(bulkDeleteMessage(3, 0)).toEqual({ tone: "success", text: "Deleted 3 events" })
    expect(bulkDeleteMessage(1, 0)).toEqual({ tone: "success", text: "Deleted 1 event" })
  })

  it("says nothing went when nothing went", () => {
    expect(bulkDeleteMessage(3, 3)).toEqual({
      tone: "error",
      text: "Could not delete those events",
    })
  })

  it("names both numbers on a partial failure", () => {
    /*
     * The branch that matters, and the reachable one: `DELETE /api/events/[id]`
     * authorizes per row through `eventPermissions().canEdit`, so a selection
     * mixing events the actor may and may not edit lands here on an ordinary
     * afternoon.
     *
     * "Could not delete those events" over a selection where four of five went
     * is worse than silence — the operator re-selects and deletes four rows
     * that are already gone.
     */
    expect(bulkDeleteMessage(5, 1)).toEqual({
      tone: "error",
      text: "Deleted 4, but 1 could not be removed",
    })
  })
})
