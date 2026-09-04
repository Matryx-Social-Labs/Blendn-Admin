import { eventTabsFor } from "@/app/dashboard/events/[id]/event-tabs"
/*
 * From the module that owns it, not through the component that re-exports it.
 *
 * Importing a pure function via a client component drags that component's
 * whole graph into the test — which broke the moment the live tab gained a
 * panel whose action imports NextAuth, an ESM package Jest cannot parse. The
 * function never moved; the import was always incidental.
 */
import { livePhaseFor } from "@/lib/event-phase"

/**
 * Event detail tabs are lifecycle-aware, and getting that wrong is worse than
 * it sounds: a Live tab on an event three weeks out shows a permanent empty
 * state, and a permanent empty state trains people to stop clicking tabs.
 *
 * The tab set also decides what a venue owner can reach at all, since the page
 * is gated on operational access rather than editorial.
 */

const START = "2026-08-05T19:00:00.000Z"
const END = "2026-08-05T23:00:00.000Z"

const at = (iso: string) => new Date(iso)
const keys = (
  start: string,
  end: string,
  opts: { canOperate: boolean; feedbackWindowOpen: boolean }
) => eventTabsFor(start, end, opts).map((t) => t.key)

describe("livePhaseFor", () => {
  it("reads the phase from the event's own schedule", () => {
    expect(livePhaseFor(START, END, at("2026-08-05T12:00:00.000Z"))).toBe("pre")
    expect(livePhaseFor(START, END, at("2026-08-05T21:00:00.000Z"))).toBe("live")
    expect(livePhaseFor(START, END, at("2026-08-06T02:00:00.000Z"))).toBe("post")
  })

  it("treats the exact boundaries as live, not as gaps", () => {
    // An event that has just started must not read as "pre" for a tick.
    expect(livePhaseFor(START, END, at(START))).toBe("live")
    expect(livePhaseFor(START, END, at(END))).toBe("live")
  })
})

describe("tab visibility follows the lifecycle", () => {
  const operator = { canOperate: true, feedbackWindowOpen: false }

  it("hides Live before doors and after the end", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-05T12:00:00.000Z"))
    expect(keys(START, END, operator)).not.toContain("live")

    jest.setSystemTime(at("2026-08-06T02:00:00.000Z"))
    expect(keys(START, END, operator)).not.toContain("live")
    jest.useRealTimers()
  })

  it("shows Live only while the event runs", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-05T21:00:00.000Z"))
    expect(keys(START, END, operator)).toContain("live")
    jest.useRealTimers()
  })

  it("shows Feedback only after the end and while the window is open", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-06T02:00:00.000Z"))
    expect(keys(START, END, { canOperate: true, feedbackWindowOpen: true })).toContain("feedback")
    // Window closed — the chat is archived, so there is nothing to read.
    expect(keys(START, END, { canOperate: true, feedbackWindowOpen: false })).not.toContain(
      "feedback"
    )
    jest.useRealTimers()
  })

  it("never shows Feedback while the event is still running", () => {
    // The window has not opened; showing it mid-event would promise a digest
    // of an event that has not finished.
    jest.useFakeTimers().setSystemTime(at("2026-08-05T21:00:00.000Z"))
    expect(keys(START, END, { canOperate: true, feedbackWindowOpen: true })).not.toContain(
      "feedback"
    )
    jest.useRealTimers()
  })
})

describe("tab visibility follows permissions", () => {
  it("gives someone without operational access only the overview", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-05T21:00:00.000Z"))
    expect(keys(START, END, { canOperate: false, feedbackWindowOpen: true })).toEqual([
      "overview",
    ])
    jest.useRealTimers()
  })

  it("gives an operator the room and the guest list", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-05T21:00:00.000Z"))
    const tabs = keys(START, END, { canOperate: true, feedbackWindowOpen: false })
    // The venue-owner case: they can operate the room without being able to
    // edit the event, so these must not depend on canEdit.
    expect(tabs).toContain("attendees")
    expect(tabs).toContain("chat")
    expect(tabs).toContain("live")
    jest.useRealTimers()
  })

  it("always starts with overview", () => {
    for (const canOperate of [true, false]) {
      expect(keys(START, END, { canOperate, feedbackWindowOpen: true })[0]).toBe("overview")
    }
  })
})
