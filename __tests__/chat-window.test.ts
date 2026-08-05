import {
  CHAT_WINDOW_HOURS,
  chatClosesAt,
  chatWindowState,
} from "@/lib/chat-window"

/**
 * The rule that was broken in production.
 *
 * A membership row was a permanent licence to write. One write path rejected
 * anything not `active`; the other rejected only `locked`, so an archived room
 * stayed writable — and archiving itself only ran when somebody happened to
 * list their chat groups, so for a quiet room it often never ran at all. People
 * were posting into events from months earlier.
 *
 * Both paths now call this. These assert the rule directly, including the case
 * that actually bit: an old room that nothing has got round to archiving.
 */

const HOUR = 60 * 60 * 1000
const ended = (hoursAgo: number) => ({ end_time: new Date(Date.now() - hoursAgo * HOUR) })

describe("chatWindowState", () => {
  it("is open while the event is running", () => {
    expect(chatWindowState({ end_time: new Date(Date.now() + HOUR) }, { status: "active" }).open).toBe(
      true
    )
  })

  it("stays open through the feedback window after the event ends", () => {
    // The window is the product feature — people say what they think while
    // still outside the venue.
    expect(chatWindowState(ended(1), { status: "active" }).open).toBe(true)
    expect(chatWindowState(ended(CHAT_WINDOW_HOURS - 1), { status: "active" }).open).toBe(true)
  })

  it("closes once the window has elapsed", () => {
    const state = chatWindowState(ended(CHAT_WINDOW_HOURS + 1), { status: "active" })
    expect(state.open).toBe(false)
    if (!state.open) expect(state.reason).toBe("window_closed")
  })

  it("closes on time even when nothing has archived the room", () => {
    // THE regression. The room is months stale and still flagged `active`
    // because the archive job never reached it. The time check must not depend
    // on the flag — jobs are late, get stuck, or have never run for a row.
    const state = chatWindowState(ended(24 * 90), { status: "active" })
    expect(state.open).toBe(false)
    if (!state.open) expect(state.reason).toBe("window_closed")
  })

  it("closes an archived room even if the window has somehow not elapsed", () => {
    const state = chatWindowState({ end_time: new Date(Date.now() + HOUR) }, { status: "archived" })
    expect(state.open).toBe(false)
    if (!state.open) expect(state.reason).toBe("archived")
  })

  it("reports locked separately from closed", () => {
    // Different words on screen: an organiser silenced this room, versus the
    // window simply ran out.
    const state = chatWindowState({ end_time: new Date(Date.now() + HOUR) }, { status: "locked" })
    expect(state.open).toBe(false)
    if (!state.open) expect(state.reason).toBe("locked")
  })

  it("closes exactly at the boundary, not a moment after", () => {
    const end = new Date("2026-08-05T20:00:00.000Z")
    const closes = chatClosesAt({ end_time: end })
    expect(chatWindowState({ end_time: end }, { status: "active" }, closes).open).toBe(false)
    expect(
      chatWindowState({ end_time: end }, { status: "active" }, new Date(closes.getTime() - 1)).open
    ).toBe(true)
  })
})

describe("chatClosesAt", () => {
  it("is the event end plus the window", () => {
    const end = new Date("2026-08-05T20:00:00.000Z")
    expect(chatClosesAt({ end_time: end }).toISOString()).toBe("2026-08-06T20:00:00.000Z")
  })
})
