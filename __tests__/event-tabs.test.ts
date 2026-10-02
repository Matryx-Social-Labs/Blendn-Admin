import { eventTabsFor, sharesLink } from "@/app/dashboard/events/[id]/event-tabs"
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
  opts: { canOperate: boolean; canEdit?: boolean; canViewAttendees?: boolean; kind?: string; status?: string }
) =>
  eventTabsFor(start, end, {
    canViewAttendees: opts.canOperate,
    canEdit: opts.canOperate,
    kind: "event",
    status: "published",
    ...opts,
  }).map((t) => t.key)

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
  const operator = { canOperate: true }

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

  it("shows Feedback once the event has ended, and keeps it after the 24h window (step 15)", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-06T02:00:00.000Z"))
    expect(keys(START, END, operator)).toContain("feedback")
    // A week on: the digest and the stars are still there to read, so the tab is.
    jest.setSystemTime(at("2026-08-12T02:00:00.000Z"))
    expect(keys(START, END, operator)).toContain("feedback")
    jest.useRealTimers()
  })

  it("never shows Feedback before the event has ended", () => {
    // Showing it mid-event would promise a digest of an event that has not finished.
    for (const now of ["2026-08-05T12:00:00.000Z", "2026-08-05T21:00:00.000Z"]) {
      jest.useFakeTimers().setSystemTime(at(now))
      expect(keys(START, END, operator)).not.toContain("feedback")
    }
    jest.useRealTimers()
  })

  it("puts the tabs in the kit's order, with QR & link last", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-06T02:00:00.000Z"))
    expect(keys(START, END, operator)).toEqual(["overview", "attendees", "chat", "announcements", "feedback", "share"])
    jest.useRealTimers()
  })
})

describe("tab visibility follows permissions", () => {
  it("gives someone without operational access only the overview", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-05T21:00:00.000Z"))
    expect(keys(START, END, { canOperate: false, canEdit: false })).toEqual(["overview"])
    jest.useRealTimers()
  })

  it("gives an operator the room and the guest list, but not the composer or the code without canEdit", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-05T21:00:00.000Z"))
    const tabs = keys(START, END, { canOperate: true, canEdit: false })
    // The venue-owner case: they can operate the room without being able to
    // edit the event, so these must not depend on canEdit.
    expect(tabs).toContain("attendees")
    expect(tabs).toContain("chat")
    expect(tabs).toContain("live")
    // Announcing into a night they do not run is K3.12 (R37); the code is
    // the host's to hand out.
    expect(tabs).not.toContain("announcements")
    expect(tabs).not.toContain("share")
    jest.useRealTimers()
  })

  it("gives whoever runs the event Announcements & sponsors", () => {
    expect(keys(START, END, { canOperate: true, canEdit: true })).toContain("announcements")
  })

  it("always starts with overview", () => {
    for (const canOperate of [true, false]) {
      expect(keys(START, END, { canOperate })[0]).toBe("overview")
    }
  })
})

describe("the QR & link tab (step 15)", () => {
  it("is offered for a published event that is not a venue day, to whoever runs it", () => {
    expect(keys(START, END, { canOperate: true, canEdit: true })).toContain("share")
    expect(sharesLink({ canEdit: true, kind: "event", status: "published" })).toBe(true)
  })

  it("is not offered for a draft, a cancelled or a completed event, which nobody can open as it stands", () => {
    for (const status of ["draft", "cancelled", "completed"]) {
      expect(keys(START, END, { canOperate: true, canEdit: true, status })).not.toContain("share")
    }
  })

  it("is not offered on a venue day, and neither is Feedback", () => {
    jest.useFakeTimers().setSystemTime(at("2026-08-06T02:00:00.000Z"))
    const tabs = keys(START, END, { canOperate: true, canEdit: true, kind: "venue_day" })
    expect(tabs).not.toContain("share")
    expect(tabs).not.toContain("feedback")
    jest.useRealTimers()
  })
})

describe("a venue day, for its venue's owner (F1)", () => {
  it("offers the room and no Attendees tab", () => {
    const tabs = keys(START, END, { canOperate: true, canEdit: false, canViewAttendees: false })
    expect(tabs).toContain("chat")
    expect(tabs).not.toContain("attendees")
  })
})
