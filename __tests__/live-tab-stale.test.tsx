import { renderToStaticMarkup } from "react-dom/server"

import type { LiveSnapshot, VenueLiveSnapshot } from "@/lib/live-metrics"
import { CONFIRMED_WINDOW_MINUTES } from "@/lib/presence"

/*
 * The Live tab says when its figures stopped (SCRUM-1348).
 *
 * Once a snapshot had arrived, a dropped socket was invisible: the old figures
 * stayed up, the hero still read "In the room · 22:41 · live", and Alerts still
 * said "Nothing needs attention". A host watching a night could not tell a
 * frozen board from a quiet room.
 */

let mockOps: { snapshot: LiveSnapshot | VenueLiveSnapshot | null; status: string } = { snapshot: null, status: "connecting" }
jest.mock("@/lib/use-ops-snapshot", () => ({ useOpsSnapshot: () => mockOps }))
// The issue log's "Mark as seen" is a server action; nothing here runs it.
jest.mock("@/app/dashboard/events/[id]/issue-actions", () => ({ acknowledgeIssue: jest.fn() }))

import { LiveTab } from "@/components/dashboard/live-tab"

const HOUR = 3_600_000
// 22:41 in Bengaluru, on the event's clock.
const AT = "2026-11-26T17:11:00.000Z"
const LINE = "Connection lost at 22:41. These figures are from then; reconnecting."

const host = (alerts: LiveSnapshot["alerts"] = []): LiveSnapshot => ({
  view: "host",
  eventId: "e1",
  at: AT,
  inside: 142,
  guestsInside: 138,
  staffInside: 4,
  checkedInTotal: 151,
  checkedOutTotal: 9,
  unconfirmed: 0,
  capacity: 195,
  fillPct: 71,
  overCapacity: false,
  checkInRate10m: 14,
  medianRate10m: 11,
  messagesPerMinute: 6,
  activeChatters30m: 31,
  openFlags: 0,
  sentiment: { positive: 20, neutral: 10, negative: 1 },
  social: null,
  categories: [],
  topics: [],
  alerts,
})

const venue = (): VenueLiveSnapshot => ({
  view: "venue",
  eventId: "e1",
  at: AT,
  inside: "100+",
  guestsInside: "100+",
  staffInside: "quiet",
  checkedInTotal: "100+",
  checkedOutTotal: "5-9",
  unconfirmed: "quiet",
  mostlyInferred: false,
  capacity: 195,
  overCapacity: false,
  checkInRate10m: "10-19",
  messagesPerMinute: 6,
  activeChatters30m: "20-49",
  openFlags: 0,
  sentiment: { positive: "20-49", neutral: "10-19", negative: "quiet" },
  raised: [],
  alerts: [],
} as unknown as VenueLiveSnapshot)

const render = (snapshot: LiveSnapshot | VenueLiveSnapshot | null, status: string) => {
  mockOps = { snapshot, status }
  return renderToStaticMarkup(
    <LiveTab
      eventId="e1"
      startAt={new Date(Date.now() - HOUR).toISOString()}
      endAt={new Date(Date.now() + HOUR).toISOString()}
      timezone="Asia/Kolkata"
    />
  )
}

describe("the Live tab after its connection drops", () => {
  it("says when the figures stopped, drops '· live', and makes no present-tense all-clear", () => {
    const html = render(host(), "error")
    expect(html).toContain(LINE)
    expect(html).not.toContain("· live")
    expect(html).not.toContain("Nothing needs attention")
    expect(html).toContain("Nothing needed attention at 22:41.")
  })

  it("announces the line in a status region that is on the page before it is filled", () => {
    // A live region inserted together with its text is not reliably read; the
    // empty region is rendered while live, and the line is put into it.
    expect(render(host(), "live")).toMatch(/<div role="status"[^>]*><\/div>/)
    expect(render(host(), "error")).toMatch(new RegExp(`role="status"[^>]*>[\\s\\S]*${LINE.replace(/[.;]/g, "\\$&")}`))
  })

  it("keeps the alerts the last snapshot had: they were true then", () => {
    const html = render(
      host([{ kind: "over_capacity", severity: "critical", title: "Over capacity", body: "142 inside against 120" }]),
      "error"
    )
    expect(html).toContain(LINE)
    expect(html).toContain("Over capacity")
  })

  it("tells a venue the same thing on its ranged copy", () => {
    const html = render(venue(), "error")
    expect(html).toContain(LINE)
    expect(html).not.toContain("· live")
  })

  it("is unchanged while live", () => {
    const html = render(host(), "live")
    expect(html).not.toContain("Connection lost")
    expect(html).toContain("In the room · 22:41 · live")
    expect(html).toContain("Nothing needs attention")
  })

  it("keeps the empty state when there was never a snapshot", () => {
    const html = render(null, "error")
    expect(html).toContain("Live connection lost")
    expect(html).not.toContain(LINE)
  })
})

/*
 * The unconfirmed line names the window it counts on (SCRUM-1232). It said "the
 * last few minutes" over a 10-minute cutoff; the cutoff is now 30, and the copy
 * reads the constant so the two cannot disagree again. design/09 rewords it.
 */
describe("the unconfirmed line", () => {
  const sentence = (n: string) => `${n} not seen in the last ${CONFIRMED_WINDOW_MINUTES} minutes — phones sleep, so they are still counted`

  it("names the confirmed window, from the one constant, for a host and a venue", () => {
    expect(CONFIRMED_WINDOW_MINUTES).toBe(30)
    expect(render({ ...host(), unconfirmed: 12 }, "live")).toContain(sentence("12"))
    expect(render({ ...venue(), unconfirmed: "10-19" } as VenueLiveSnapshot, "live")).toContain(sentence("10–19"))
  })

  it("is not said when everybody inside was seen", () => {
    expect(render(host(), "live")).not.toContain("not seen in the last")
  })
})
