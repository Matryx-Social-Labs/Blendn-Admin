import { deriveAlerts, type LiveSnapshot } from "@/lib/live-metrics"

/**
 * Alert rules, pinned.
 *
 * The rules that matter combine chat and check-in signal, because neither
 * means much alone: a check-in spike is just a popular act arriving, and
 * grumbling about a queue is routine. Together they are a door that has
 * stopped moving.
 *
 * The failure mode to guard against is not a missed alert — it is a noisy one.
 * An operations screen that cries wolf during the busiest hour of someone's
 * night gets ignored, and then the real alert is ignored too.
 */

const base: LiveSnapshot = {
  eventId: "evt",
  at: "2026-08-05T22:45:00.000Z",
  inside: 40,
  guestsInside: 38,
  staffInside: 2,
  checkedInTotal: 45,
  checkedOutTotal: 5,
  // Nobody inferred: these fixtures are all direct observation.
  staleInside: 0,
  capacity: 80,
  fillPct: 48,
  overCapacity: false,
  checkInRate10m: 8,
  medianRate10m: 8,
  messagesPerMinute: 2,
  activeChatters30m: 12,
  openFlags: 0,
  sentiment: { positive: 5, neutral: 4, negative: 2 },
  categories: [],
}

const NOW = new Date("2026-08-05T22:45:00.000Z")
const END_LATER = new Date("2026-08-05T23:59:00.000Z")
const END_SOON = new Date("2026-08-05T22:50:00.000Z")

const kinds = (s: LiveSnapshot, end = END_LATER) =>
  deriveAlerts(s, { scheduledEnd: end, now: NOW }).map((a) => a.kind)

describe("a normal night fires nothing", () => {
  it("stays quiet on the baseline snapshot", () => {
    expect(kinds(base)).toEqual([])
  })
})

describe("entry backing up needs both signals", () => {
  it("does not fire on a check-in spike alone", () => {
    // A rush at the door is what a good event looks like.
    expect(kinds({ ...base, checkInRate10m: 31 })).not.toContain("entry_backing_up")
  })

  it("does not fire on queue complaints alone", () => {
    // People grumble about queues at every event ever held.
    expect(
      kinds({ ...base, categories: [{ category: "entry_queue", count: 6 }] })
    ).not.toContain("entry_backing_up")
  })

  it("fires when the rate spikes AND the chat agrees", () => {
    expect(
      kinds({
        ...base,
        checkInRate10m: 31,
        categories: [{ category: "entry_queue", count: 6 }],
      })
    ).toContain("entry_backing_up")
  })

  it("compares against this event's own baseline, not an absolute", () => {
    // 31 arrivals is a stampede for a book club and a slow night for a
    // festival. A fixed threshold would be wrong for one of them.
    const busyVenue = {
      ...base,
      checkInRate10m: 31,
      medianRate10m: 30,
      categories: [{ category: "entry_queue", count: 6 }],
    }
    expect(kinds(busyVenue)).not.toContain("entry_backing_up")
  })
})

describe("safety escalates on category, never on tone", () => {
  it("fires on a single safety_conduct message", () => {
    const alerts = deriveAlerts(
      { ...base, categories: [{ category: "safety_conduct", count: 1 }] },
      { scheduledEnd: END_LATER, now: NOW }
    )
    const safety = alerts.find((a) => a.kind === "safety")
    expect(safety).toBeDefined()
    expect(safety!.severity).toBe("critical")
  })

  it("fires even when overall sentiment is positive", () => {
    // A composed report inside a happy room is still a report. Routing on tone
    // would bury exactly the message that matters most.
    expect(
      kinds({
        ...base,
        sentiment: { positive: 30, neutral: 5, negative: 0 },
        categories: [{ category: "safety_conduct", count: 1 }],
      })
    ).toContain("safety")
  })
})

describe("leaving early only means something before the end", () => {
  it("fires when a quarter have left with time still to run", () => {
    expect(kinds({ ...base, checkedInTotal: 40, checkedOutTotal: 12 })).toContain(
      "leaving_early"
    )
  })

  it("stays quiet near the scheduled end, when leaving is the point", () => {
    expect(
      kinds({ ...base, checkedInTotal: 40, checkedOutTotal: 12 }, END_SOON)
    ).not.toContain("leaving_early")
  })
})

describe("capacity", () => {
  it("fires at 90% and not at 78%", () => {
    expect(kinds({ ...base, fillPct: 78 })).not.toContain("approaching_capacity")
    expect(kinds({ ...base, fillPct: 91 })).toContain("approaching_capacity")
  })

  it("cannot fire when no capacity is set", () => {
    // No stated capacity means no target to approach — inventing one would put
    // a red banner on an event that has no problem.
    expect(kinds({ ...base, capacity: null, fillPct: null })).not.toContain(
      "approaching_capacity"
    )
  })

  it("escalates to over_capacity past the line, and only one of the two fires", () => {
    // Check-in no longer refuses at capacity, so a room over its stated size is
    // observable for the first time. "Approaching" alongside "over" would be
    // two alerts about one room, and the weaker one dilutes the stronger.
    const over = kinds({ ...base, guestsInside: 88, inside: 92, fillPct: 110, overCapacity: true })
    expect(over).toContain("over_capacity")
    expect(over).not.toContain("approaching_capacity")
  })

  it("reports the breach against guests, not bodies", () => {
    // Fill is a guest measure — four crew must not fill a room of four — but the
    // organiser still needs the body count for the fire officer, so the alert
    // carries both.
    const [alert] = deriveAlerts(
      { ...base, guestsInside: 88, inside: 92, staffInside: 4, fillPct: 110, overCapacity: true },
      { scheduledEnd: END_LATER, now: NOW }
    )
    expect(alert.kind).toBe("over_capacity")
    expect(alert.severity).toBe("critical")
    expect(alert.body).toContain("88 guests against capacity 80")
    expect(alert.body).toContain("8 over")
    expect(alert.body).toContain("92 bodies")
  })
})

describe("mood needs enough messages to be a mood", () => {
  it("ignores a high negative share on a handful of messages", () => {
    // 2 of 3 negative is two people, not a trend.
    expect(
      kinds({ ...base, sentiment: { positive: 1, neutral: 0, negative: 2 } })
    ).not.toContain("mood_sliding")
  })

  it("fires once the sample is big enough", () => {
    expect(
      kinds({ ...base, sentiment: { positive: 5, neutral: 3, negative: 8 } })
    ).toContain("mood_sliding")
  })
})

describe("the snapshot carries no identity", () => {
  it("has no field that could name an attendee", () => {
    // Pseudonymity has to hold on the wire, not just in the REST payload — a
    // long-lived channel streaming user ids would reintroduce the leak through
    // a side door that nobody inspects.
    const json = JSON.stringify(base)
    expect(json).not.toContain("userId")
    expect(json).not.toContain("user_id")
    expect(json).not.toContain("@")
    for (const key of Object.keys(base)) {
      expect(key.toLowerCase()).not.toContain("name")
      expect(key.toLowerCase()).not.toContain("email")
    }
  })
})

describe("a room that has gone quiet", () => {
  const START = new Date("2026-08-05T21:00:00.000Z") // 1h45m before NOW
  const quiet = { ...base, inside: 20, activeChatters30m: 0, messagesPerMinute: 0 }
  // Deliberately not a default parameter: passing `undefined` to one falls back
  // to the default, so the "no start time" case would have silently asserted the
  // opposite of what it reads as. It did, on the first run.
  const withStart = (s: typeof base, start: Date | null) =>
    deriveAlerts(s, {
      scheduledEnd: END_LATER,
      ...(start ? { scheduledStart: start } : {}),
      now: NOW,
    }).map((a) => a.kind)

  it("fires when a full room has said nothing for half an hour", () => {
    // The one alert about the product failing rather than the venue: people came,
    // they are still here, and the introductions are not happening.
    expect(withStart(quiet, START)).toContain("room_died")
  })

  it("cannot fire without a start time", () => {
    // Arrivals do not chat immediately. With no way to know how long the event
    // has been running, the rule declines rather than guessing.
    expect(withStart(quiet, null)).not.toContain("room_died")
  })

  it("does not fire in the first half hour", () => {
    // Firing at doors would put this on every event ever held.
    const justStarted = new Date(NOW.getTime() - 20 * 60 * 1000)
    expect(withStart(quiet, justStarted)).not.toContain("room_died")
  })

  it("does not fire on a nearly-empty room", () => {
    // Three people not talking is three people, not a signal.
    expect(withStart({ ...quiet, inside: 4 }, START)).not.toContain("room_died")
  })

  it("does not fire while anyone is still talking", () => {
    // One person is enough to say the room is alive.
    expect(withStart({ ...quiet, activeChatters30m: 1 }, START)).not.toContain("room_died")
  })

  it("does not fire as the event winds down", () => {
    // A room emptying out near the end is what is supposed to happen.
    expect(
      deriveAlerts(quiet, { scheduledEnd: END_SOON, scheduledStart: START, now: NOW }).map((a) => a.kind)
    ).not.toContain("room_died")
  })
})
