import {
  evaluatePresence,
  shouldPersistPing,
  DEPARTURE_GRACE_MINUTES,
  PROMPT_TIMEOUT_MINUTES,
  OCCURRENCE_GRACE_MINUTES,
  PING_INTERVAL_MINUTES,
  type PresenceState,
} from "@/lib/presence"
import type { Geofence } from "@/lib/geofence"

/**
 * Is this person still here?
 *
 * Every rule below is a judgment call about noisy sensor data, and getting one
 * wrong has a specific, ugly consequence: eject someone who is dancing, or keep
 * counting someone who left an hour ago. The one that would be worst is a venue
 * whose signal dies reading as an evacuation, which is why silence and a
 * confirmed out-of-bounds reading are treated so differently.
 */

// Toit, Indiranagar. 40m fence with a 20m buffer — 60m of allowance before any
// accuracy is folded in.
const FENCE: Geofence = { type: "circle", lat: 12.9784, lng: 77.6408, radius: 40, buffer: 20 }
const INSIDE = { lat: 12.9784, lng: 77.6408 }
/** ~500m north. Well outside anything the allowance can excuse. */
const OUTSIDE = { lat: 12.9829, lng: 77.6408 }

const NOW = new Date("2026-09-10T21:00:00Z")
const ENDS = new Date("2026-09-11T02:00:00Z")
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000)

const state = (over: Partial<PresenceState> = {}): PresenceState => ({
  kind: "attendee",
  leftAreaAt: null,
  departurePromptedAt: null,
  lastSeenAt: ago(5),
  ...over,
})

const ping = (point: { lat: number; lng: number }, accuracy: number | null = 10) => ({
  point,
  accuracy,
})

describe("still inside", () => {
  it("stays when the ping is inside", () => {
    const d = evaluatePresence(state(), ping(INSIDE), FENCE, ENDS, NOW)
    expect(d.action).toBe("stay")
    expect(d.reason).toBe("inside")
  })

  it("clears a departure when they come back", () => {
    // Went out, came back. Whatever we thought was happening, it was not a
    // departure — and the clock must reset or the next wobble ejects them.
    const d = evaluatePresence(
      state({ leftAreaAt: ago(30) }),
      ping(INSIDE),
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("clear_departure")
    expect(d.reason).toBe("returned")
  })

  it("clears a departure even after we already prompted", () => {
    // They answered by walking back in.
    const d = evaluatePresence(
      state({ leftAreaAt: ago(40), departurePromptedAt: ago(20) }),
      ping(INSIDE),
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("clear_departure")
  })
})

describe("GPS drift is not departure", () => {
  it("treats a poor fix just outside as still inside", () => {
    // 50m out with 60m of reported error. That is a phone indoors, not someone
    // who left. Judged with the same allowance check-in uses, so the two rules
    // cannot disagree.
    const nearby = { lat: 12.97885, lng: 77.6408 } // ~50m north
    const d = evaluatePresence(state(), ping(nearby, 60), FENCE, ENDS, NOW)
    expect(d.action).toBe("stay")
  })

  it("does not let a wildly optimistic accuracy claim excuse being far away", () => {
    // 500m out, claiming 5m accuracy. No allowance covers that.
    const d = evaluatePresence(state(), ping(OUTSIDE, 5), FENCE, ENDS, NOW)
    expect(d.action).toBe("record_departure")
  })

  it("caps a wildly pessimistic accuracy claim", () => {
    // A device claiming 5km of error must not thereby be "inside" everywhere.
    const d = evaluatePresence(state(), ping(OUTSIDE, 5000), FENCE, ENDS, NOW)
    expect(d.action).toBe("record_departure")
  })
})

describe("leaving", () => {
  it("records the first reading outside without acting on it", () => {
    // One sample is not evidence. Start the clock.
    const d = evaluatePresence(state(), ping(OUTSIDE), FENCE, ENDS, NOW)
    expect(d.action).toBe("record_departure")
    expect(d.shortfall).toBeGreaterThan(0)
  })

  it("waits out the grace period — a cigarette is not leaving", () => {
    const d = evaluatePresence(
      state({ leftAreaAt: ago(DEPARTURE_GRACE_MINUTES - 1) }),
      ping(OUTSIDE),
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("stay")
  })

  it("prompts once the grace period expires", () => {
    const d = evaluatePresence(
      state({ leftAreaAt: ago(DEPARTURE_GRACE_MINUTES + 1) }),
      ping(OUTSIDE),
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("prompt")
    expect(d.reason).toBe("grace_expired")
  })

  it("does not prompt twice for the same departure", () => {
    // Being asked "are you still here?" every five minutes while dancing is its
    // own kind of broken.
    const d = evaluatePresence(
      state({ leftAreaAt: ago(30), departurePromptedAt: ago(1) }),
      ping(OUTSIDE),
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("stay")
  })

  it("checks out when the prompt goes unanswered", () => {
    const d = evaluatePresence(
      state({
        leftAreaAt: ago(60),
        departurePromptedAt: ago(PROMPT_TIMEOUT_MINUTES + 1),
      }),
      ping(OUTSIDE),
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("auto_checkout")
    expect(d.reason).toBe("no_response")
  })
})

describe("silence is not departure", () => {
  it("stays put when no ping arrives at all", () => {
    // The rule that matters most. No ping can mean a backgrounded app, a
    // suspended process, a basement with no signal, a dead battery, a revoked
    // permission. A venue whose signal dies must not read as an evacuation.
    const d = evaluatePresence(state({ lastSeenAt: ago(120) }), null, FENCE, ENDS, NOW)
    expect(d.action).toBe("stay")
    expect(d.reason).toBe("no_signal")
  })

  it("DOES act on silence that follows a confirmed departure", () => {
    // The distinction that makes the sweeper work at all, and one an earlier
    // version of this file got wrong.
    //
    // Silence alone is ambiguous, so it does nothing. But silence *after* a
    // reading that put them outside is different: we have positive evidence
    // they stepped out, we asked them, and they did not answer. Only the
    // sweeper can observe that timeout, and it never carries a ping — so if
    // silence short-circuits here, the grace and prompt clocks are unreachable
    // and nobody is ever checked out.
    const d = evaluatePresence(
      state({ leftAreaAt: ago(120), departurePromptedAt: ago(90) }),
      null,
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("auto_checkout")
    expect(d.reason).toBe("no_response")
  })

  it("still waits out the grace when silent after stepping out", () => {
    const d = evaluatePresence(
      state({ leftAreaAt: ago(DEPARTURE_GRACE_MINUTES - 2) }),
      null,
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("stay")
  })

  it("prompts on silence once the grace has expired", () => {
    const d = evaluatePresence(
      state({ leftAreaAt: ago(DEPARTURE_GRACE_MINUTES + 5) }),
      null,
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("prompt")
  })
})

describe("the day ending", () => {
  it("closes anyone still checked in once the occurrence is well over", () => {
    const over = new Date(NOW.getTime() - (OCCURRENCE_GRACE_MINUTES + 1) * 60_000)
    const d = evaluatePresence(state(), ping(INSIDE), FENCE, over, NOW)
    expect(d.action).toBe("auto_checkout")
    expect(d.reason).toBe("occurrence_ended")
  })

  it("does not close during the grace after the end time", () => {
    // The room does not empty on the stroke of the end time.
    const justOver = new Date(NOW.getTime() - (OCCURRENCE_GRACE_MINUTES - 5) * 60_000)
    const d = evaluatePresence(state(), ping(INSIDE), FENCE, justOver, NOW)
    expect(d.action).toBe("stay")
  })

  it("closes staff too, once the day is over", () => {
    // The one automatic checkout staff are not exempt from. Otherwise their
    // check-in stays open for ever and day two counts them twice.
    const over = new Date(NOW.getTime() - (OCCURRENCE_GRACE_MINUTES + 1) * 60_000)
    const d = evaluatePresence(state({ kind: "staff" }), null, FENCE, over, NOW)
    expect(d.action).toBe("auto_checkout")
  })
})

describe("staff", () => {
  it("is never auto-checked-out mid-event, even far outside", () => {
    // Out the back, working the queue, meeting a supplier. Ejecting the
    // organiser from the chatroom they are moderating is worse than a stale
    // staff count.
    const d = evaluatePresence(
      state({ kind: "staff", leftAreaAt: ago(120), departurePromptedAt: ago(90) }),
      ping(OUTSIDE),
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("stay")
    expect(d.reason).toBe("staff_exempt")
  })

  it("is not even prompted", () => {
    const d = evaluatePresence(
      state({ kind: "staff", leftAreaAt: ago(30) }),
      ping(OUTSIDE),
      FENCE,
      ENDS,
      NOW
    )
    expect(d.action).toBe("stay")
  })
})

describe("shouldPersistPing", () => {
  it("always writes when something changed", () => {
    for (const action of ["record_departure", "prompt", "auto_checkout", "clear_departure"] as const) {
      expect(shouldPersistPing({ action, reason: "left_area" }, state(), NOW)).toBe(true)
    }
  })

  it("skips a quiet ping that arrives too soon", () => {
    // 500 attendees every five minutes is 100 writes a minute if each one is
    // persisted, and near zero if only the interesting ones are.
    expect(
      shouldPersistPing({ action: "stay", reason: "inside" }, state({ lastSeenAt: ago(1) }), NOW)
    ).toBe(false)
  })

  it("writes a quiet ping once the interval has passed", () => {
    expect(
      shouldPersistPing(
        { action: "stay", reason: "inside" },
        state({ lastSeenAt: ago(PING_INTERVAL_MINUTES + 1) }),
        NOW
      )
    ).toBe(true)
  })

  it("writes the very first ping", () => {
    expect(
      shouldPersistPing({ action: "stay", reason: "inside" }, state({ lastSeenAt: null }), NOW)
    ).toBe(true)
  })
})
