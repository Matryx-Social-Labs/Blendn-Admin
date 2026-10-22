import {
  CHAT_WINDOW_HOURS,
  chatClosesAt,
  chatWindowState,
  liveInVenueDay,
  mayWriteToRoom,
  roomReadDenial,
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
const ended = (hoursAgo: number) => ({ end_time: new Date(Date.now() - hoursAgo * HOUR), deleted_at: null, kind: "event" as const })

describe("chatWindowState", () => {
  it("is open while the event is running", () => {
    expect(chatWindowState({ end_time: new Date(Date.now() + HOUR), deleted_at: null, kind: "event" as const }, { status: "active" }).open).toBe(
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
    const state = chatWindowState({ end_time: new Date(Date.now() + HOUR), deleted_at: null, kind: "event" as const }, { status: "archived" })
    expect(state.open).toBe(false)
    if (!state.open) expect(state.reason).toBe("archived")
  })

  it("reports locked separately from closed", () => {
    // Different words on screen: an organiser silenced this room, versus the
    // window simply ran out.
    const state = chatWindowState({ end_time: new Date(Date.now() + HOUR), deleted_at: null, kind: "event" as const }, { status: "locked" })
    expect(state.open).toBe(false)
    if (!state.open) expect(state.reason).toBe("locked")
  })

  it("closes exactly at the boundary, not a moment after", () => {
    const end = new Date("2026-08-05T20:00:00.000Z")
    const closes = chatClosesAt({ end_time: end })
    expect(chatWindowState({ end_time: end, deleted_at: null, kind: "event" as const }, { status: "active" }, closes).open).toBe(false)
    expect(
      chatWindowState({ end_time: end, deleted_at: null, kind: "event" as const }, { status: "active" }, new Date(closes.getTime() - 1)).open
    ).toBe(true)
  })
})

describe("chatClosesAt", () => {
  it("is the event end plus the window", () => {
    const end = new Date("2026-08-05T20:00:00.000Z")
    expect(chatClosesAt({ end_time: end }).toISOString()).toBe("2026-08-06T20:00:00.000Z")
  })
})

/*
 * A venue day's room is for the people live in it (plan v2 F6, F7, D-4, D-5).
 * `last_allowed_at` is the end of the member's Go Live; at an event's room it
 * is never read (room-write-access.test.ts).
 */
describe("a venue day's room", () => {
  const NOW = new Date("2026-10-02T15:00:00Z")
  const DAY = {
    start_time: new Date("2026-10-02T00:30:00Z"),
    end_time: new Date("2026-10-03T00:30:00Z"),
    status: "published" as const,
    deleted_at: null,
    kind: "venue_day" as const,
  }
  const OPEN = { status: "active" as const }
  const member = (lastAllowed: Date | null) => ({ status: "active", left_at: null, last_allowed_at: lastAllowed })
  const later = new Date(NOW.getTime() + 60_000)
  const earlier = new Date(NOW.getTime() - 60_000)

  it("is open to a member whose window is open", () => {
    expect(liveInVenueDay(DAY, member(later), NOW)).toBe(true)
    expect(roomReadDenial(member(later), DAY, NOW)).toBeNull()
    expect(mayWriteToRoom(member(later), DAY, OPEN, NOW)).toBeNull()
  })

  it("is closed — read and write — once the window has ended, without waiting for the sweeper", () => {
    expect(roomReadDenial(member(earlier), DAY, NOW)).toBe("not_live")
    expect(mayWriteToRoom(member(earlier), DAY, OPEN, NOW)).toEqual({ reason: "not_live" })
    // At the very instant it ends.
    expect(mayWriteToRoom(member(NOW), DAY, OPEN, NOW)).toEqual({ reason: "not_live" })
  })

  it("fails closed for a member with no window at all", () => {
    expect(roomReadDenial(member(null), DAY, NOW)).toBe("not_live")
    expect(mayWriteToRoom(member(null), DAY, OPEN, NOW)).toEqual({ reason: "not_live" })
  })

  it("leaves an event's room exactly as it was, whatever last_allowed_at says", () => {
    const EVENT = { ...DAY, kind: "event" as const }
    expect(liveInVenueDay(EVENT, member(earlier), NOW)).toBe(true)
    expect(roomReadDenial(member(earlier), EVENT, NOW)).toBeNull()
  })

  it("closes at the reset, not a day later (D-5)", () => {
    expect(chatClosesAt(DAY)).toEqual(DAY.end_time)
    const atReset = chatWindowState(DAY, OPEN, DAY.end_time)
    expect(atReset).toEqual({ open: false, reason: "window_closed" })
    expect(chatWindowState(DAY, OPEN, new Date(DAY.end_time.getTime() - 1)).open).toBe(true)
  })

  it("still answers banned and hidden first", () => {
    expect(roomReadDenial({ ...member(earlier), status: "banned" }, DAY, NOW)).toBe("banned")
    expect(roomReadDenial(member(later), { ...DAY, deleted_at: NOW }, NOW)).toBe("hidden")
    expect(mayWriteToRoom({ status: "muted", last_allowed_at: earlier }, DAY, OPEN, NOW)).toEqual({ reason: "muted" })
  })
})
