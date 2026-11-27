import { renderToStaticMarkup } from "react-dom/server"

import { deriveAlerts, type LiveFigures, type LiveSnapshot, type VenueLiveSnapshot } from "@/lib/live-metrics"

/*
 * The Live tab's "in the room" as a range (SCRUM-1328, design/09; picks in
 * artefacts/09-count-range/CHAIN.md).
 *
 * The figure is "seen – checked in": the low end is who reported, or checked
 * in, within the confirmed window, the high end everyone not seen leaving. One
 * sentence says what the low end is. Capacity is judged on the high end, always:
 * the old "count unreliable" treatment hid the over-capacity pill exactly when a
 * full room's phones were in pockets. The venue keeps its rounded high end.
 */

let mockOps: { snapshot: LiveSnapshot | VenueLiveSnapshot | null; status: string } = { snapshot: null, status: "connecting" }
jest.mock("@/lib/use-ops-snapshot", () => ({ useOpsSnapshot: () => mockOps }))
jest.mock("@/app/dashboard/events/[id]/issue-actions", () => ({ acknowledgeIssue: jest.fn() }))

import { LiveTab } from "@/components/dashboard/live-tab"

const HOUR = 3_600_000
// 22:41 in Bengaluru, on the event's clock.
const AT = "2026-11-26T17:11:00.000Z"
const LOST = "Connection lost at 22:41. These figures are from then; reconnecting."

const figures = (over: Partial<LiveFigures> = {}): LiveFigures => ({
  eventId: "e1",
  at: AT,
  inside: 52,
  guestsInside: 52,
  staffInside: 0,
  checkedInTotal: 61,
  checkedOutTotal: 9,
  unconfirmed: 14,
  capacity: 80,
  fillPct: 65,
  overCapacity: false,
  checkInRate10m: 4,
  medianRate10m: 0,
  messagesPerMinute: 2,
  activeChatters30m: 11,
  openFlags: 0,
  sentiment: { positive: 4, neutral: 2, negative: 0 },
  categories: [],
  ...over,
})

const host = (over: Partial<LiveFigures> = {}): LiveSnapshot => {
  const f = figures(over)
  return { ...f, view: "host", social: null, categories: [], topics: [], alerts: deriveAlerts(f, { scheduledEnd: new Date(Date.parse(AT) + HOUR) }) }
}

const venue = (over: Partial<VenueLiveSnapshot> = {}): VenueLiveSnapshot => ({
  view: "venue",
  eventId: "e1",
  at: AT,
  inside: "20+",
  guestsInside: "20+",
  staffInside: "quiet",
  checkedInTotal: "20+",
  checkedOutTotal: "5-9",
  unconfirmed: "10-19",
  mostlyInferred: false,
  capacity: 80,
  overCapacity: false,
  checkInRate10m: "quiet",
  messagesPerMinute: 2,
  activeChatters30m: "10-19",
  openFlags: 0,
  sentiment: { positive: "quiet", neutral: "quiet", negative: "quiet" },
  categories: [],
  alerts: [],
  ...over,
})

const render = (snapshot: LiveSnapshot | VenueLiveSnapshot, status = "live") => {
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

/** The hero: the section that holds "In the room". */
const hero = (html: string) => {
  const start = html.lastIndexOf("<section", html.indexOf("In the room"))
  return html.slice(start, html.indexOf("</section>", start))
}

describe("the host's room figure is a range", () => {
  it("reads seen – checked in, says it aloud in full, and says what the low end is", () => {
    const h = hero(render(host({ inside: 3, guestsInside: 3, unconfirmed: 1, capacity: null, fillPct: null })))
    expect(h).toContain(">2–3<")
    expect(h).toContain(">here<")
    expect(h).toContain("2 to 3 people here")
    expect(h).toContain("2 were seen in the last 30 minutes; the other one is still checked in, but their phone has gone quiet, as phones in pockets do.")
  })

  it("is one number when everybody was seen", () => {
    const h = hero(render(host({ unconfirmed: 0 })))
    expect(h).toContain(">52<")
    expect(h).not.toContain("–52")
    expect(h).toContain("Everyone here was seen in the last 30 minutes.")
  })

  it("starts at 0 when every phone is asleep, with no 'unreliable' treatment", () => {
    const h = hero(render(host({ unconfirmed: 52 })))
    expect(h).toContain(">0–52<")
    expect(h).toContain("Nobody was seen in the last 30 minutes; all 52 are still checked in")
    expect(h).not.toContain("count unreliable")
    expect(h).not.toContain("roughly")
    expect(h).not.toContain("~")
  })

  it("is compact for a concert, with the full numbers in its accessible name and its sentence", () => {
    const h = hero(render(host({ inside: 12_480, guestsInside: 12_440, staffInside: 40, unconfirmed: 2_520, capacity: 15_000, fillPct: 83 })))
    expect(h).toContain(">9.9k–12k<")
    expect(h).toContain("9,960 to 12,480 people here")
    expect(h).toContain("9,960 were seen in the last 30 minutes; the other 2,520 are still checked in")
  })

  it("drops the old stopgap sentence and keeps the rest of the description", () => {
    const h = hero(render(host()))
    expect(h).not.toContain("not seen in the last")
    expect(h).not.toContain("phones sleep")
    expect(h).toContain("61 checked in, 9 left")
  })

  it("draws both ends on the fill bar: solid to the seen, hatched to everyone", () => {
    // 38 seen and 52 in, of 80: solid to 47.5%, the hatch from there for 17.5%.
    const h = hero(render(host()))
    expect(h).toMatch(/left:0;width:47\.5%|width:47\.5%/)
    expect(h).toMatch(/left:47\.5%;width:17\.5%/)
  })

  it("keeps the 02c stale state on top of a range: frozen range, no '· live'", () => {
    const html = render(host(), "error")
    expect(html).toContain(LOST)
    const h = hero(html)
    expect(h).toContain(">38–52<")
    expect(h).not.toContain("· live")
  })
})

describe("capacity reads the high end", () => {
  // 52 checked in against 50; only 12 seen recently, so the low end is under it.
  const over = { guestsInside: 52, inside: 52, unconfirmed: 40, capacity: 50, fillPct: 104, overCapacity: true }

  it("shows the over-capacity pill even when most of the room is unconfirmed", () => {
    const h = hero(render(host(over)))
    expect(h).toContain(">12–52<")
    expect(h).toContain("2 over stated capacity")
    expect(h).toContain("52 guests against capacity 50")
  })

  it("raises the over-capacity alert on everyone checked in, not on the seen", () => {
    const alerts = deriveAlerts(figures(over), { scheduledEnd: new Date(Date.parse(AT) + HOUR) })
    expect(alerts.map((a) => a.kind)).toContain("over_capacity")
    expect(alerts.find((a) => a.kind === "over_capacity")?.body).toContain("52 guests against capacity 50 — 2 over")
  })

  it("does not fire on the high end's share of unconfirmed when the room is under capacity", () => {
    const alerts = deriveAlerts(figures({ unconfirmed: 52 }), { scheduledEnd: new Date(Date.parse(AT) + HOUR) })
    expect(alerts.map((a) => a.kind)).not.toContain("over_capacity")
  })
})

describe("the venue's copy stays the rounded high end", () => {
  it("has no range, no low end and no unconfirmed sentence", () => {
    const h = hero(render(venue()))
    expect(h).toContain(">20+<")
    expect(h).toContain("in the room")
    expect(h).not.toMatch(/\d–\d+ here/)
    expect(h).not.toContain("not seen in the last")
    expect(h).not.toContain("were seen")
    expect(h).not.toContain("10–19")
  })

  it("under the floor reads 'Under 5', as today", () => {
    expect(hero(render(venue({ inside: "quiet", guestsInside: "quiet" })))).toContain(">Under 5<")
  })

  it("never greys its figure or hides its over-capacity flag for an unconfirmed room", () => {
    const h = hero(render(venue({ mostlyInferred: true, overCapacity: true })))
    expect(h).not.toContain("count unreliable")
    expect(h).not.toContain("roughly")
    expect(h).toContain("over stated capacity")
  })
})

describe("a screen reader is not told the range every five seconds", () => {
  it("keeps the hero out of every live region; the stale line's region is the only one", () => {
    const html = render(host())
    expect(html.match(/role="status"|aria-live/g)).toEqual(['role="status"'])
    // ...and that region is empty while the figures are live, whatever the range does.
    expect(html).toMatch(/<div role="status"[^>]*><\/div>/)
    expect(render(host({ unconfirmed: 20 }))).toMatch(/<div role="status"[^>]*><\/div>/)
    expect(hero(html)).not.toMatch(/aria-live|role="status"|role="alert"/)
  })

  it("reads the range once, as words, and hides the glyphs from it", () => {
    const h = hero(render(host()))
    expect(h).toMatch(/<span class="sr-only">38 to 52 people here<\/span>/)
    expect(h).toMatch(/aria-hidden="true"[^>]*>38–52</)
  })
})
