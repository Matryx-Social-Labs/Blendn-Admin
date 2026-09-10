import { earlierIssues, issueOpenedLabel } from "@/lib/issue-timestamp"

/**
 * An issue's opening time cannot be read as today when it was not.
 *
 * The live tab rendered time of day and nothing else, under a heading saying
 * "Tonight's issues", while `issuesFor` returns the event's whole history. On
 * staging that put an issue opened **yesterday at 19:54** on a panel beside a
 * room clock reading **19:47** — so a day-old problem read as one seven minutes
 * in the future, with "ongoing 23h 53m" on the same line contradicting it.
 *
 * The dates below are the two real rows from that screen.
 */
describe("when an issue opened", () => {
  /*
   * The run is pinned to UTC by `jest.config.ts`, so these are exact rather
   * than shape assertions — a date test that only checks "contains a month" is
   * the kind that passes against an off-by-one.
   */
  it("says the time alone when it opened today", () => {
    /*
     * The ordinary case, and the reason the date is conditional: a one-night
     * event wants `21:40 · lasted 12 min`, not a date on every row.
     */
    const now = new Date("2026-09-10T17:47:00Z")
    expect(issueOpenedLabel("2026-09-10T17:54:44.088Z", now)).toBe("17:54")
  })

  it("names the day when it did not", () => {
    // The row that read as the future.
    const now = new Date("2026-09-10T17:47:00Z")
    expect(issueOpenedLabel("2026-09-09T17:54:44.088Z", now)).toBe("9 Sept, 17:54")
  })

  it("names the day for something days back", () => {
    const now = new Date("2026-09-10T17:47:00Z")
    expect(issueOpenedLabel("2026-09-04T22:04:54.013Z", now)).toBe("4 Sept, 22:04")
  })

  it("names the day across midnight even twenty minutes later", () => {
    /*
     * Calendar day, not elapsed hours. "23:50" under a clock reading "00:10" is
     * the same ambiguity in miniature, and an hours-based rule would miss it.
     */
    const now = new Date("2026-09-11T00:10:00Z")
    expect(issueOpenedLabel("2026-09-10T23:50:00Z", now)).toBe("10 Sept, 23:50")
  })

  it("uses the reader's own clock, not UTC", () => {
    /*
     * The date shown is the local one, because it is the organiser's calendar
     * the panel is claiming things about. Asserted through the ambient
     * timezone rather than by reading the implementation, so a switch to a
     * fixed offset would fail here.
     */
    const shown = issueOpenedLabel("2026-09-04T22:04:54.013Z", new Date("2026-09-10T17:47:00Z"))
    const local = new Date("2026-09-04T22:04:54.013Z").toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    })
    expect(shown).toContain(local)
  })
})

describe("the issue log does not repeat the alerts above it", () => {
  const open = (kind: string) => ({ kind, resolvedAt: null })
  const resolved = (kind: string) => ({ kind, resolvedAt: "2026-09-09T17:54:44.088Z" })

  it("hides an open issue the alerts are already showing", () => {
    /*
     * The staging case: "Leaving early" under Alerts and again in the log,
     * identical body, one panel apart.
     */
    expect(earlierIssues([open("leaving_early")], ["leaving_early"])).toEqual([])
  })

  it("keeps an open issue the current snapshot no longer derives", () => {
    /*
     * The reason this filters on `kind` and not on `resolvedAt`. The sweep has
     * it open, the live rule has stopped firing — that gap is the whole point
     * of recording issues at all, and a blanket "hide the open ones" would
     * swallow it.
     */
    expect(earlierIssues([open("room_died")], ["leaving_early"])).toEqual([open("room_died")])
  })

  it("always keeps a resolved issue, even of a kind firing again now", () => {
    // "The queue cleared itself twenty minutes ago" survives the queue backing
    // up a second time; they are two separate nights' worth of information.
    const rows = [resolved("leaving_early")]
    expect(earlierIssues(rows, ["leaving_early"])).toEqual(rows)
  })

  it("passes everything through when nothing is alerting", () => {
    const rows = [open("safety"), resolved("room_died")]
    expect(earlierIssues(rows, [])).toEqual(rows)
  })
})
