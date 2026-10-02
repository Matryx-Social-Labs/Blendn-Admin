import { liveCountBucket, liveCountLabel } from "@/lib/disclosure"
import { alertsForVenue, forVenue, type LiveAlertKind, type LiveSnapshot } from "@/lib/live-metrics"

/**
 * A venue watching a night it does not run gets its live counts as buckets
 * (SCRUM-516, D-19).
 *
 * The floor alone is beaten by watching: "fewer than 5" turning into 5 the
 * moment somebody walks in says they did (F14). Ranges move only at their
 * edges. These pin the edges (the same `liveCountBucket` the app's Go Live
 * answer uses), the dashboard's words for them, and that the venue's copy of the snapshot
 * carries no count of people as a number at all.
 */

describe("liveCountBucket", () => {
  it.each([
    [0, "none", "0"],
    [1, "a_few", "a few"],
    [4, "a_few", "a few"],
    [5, "5-9", "5–9"],
    [9, "5-9", "5–9"],
    [10, "10-19", "10–19"],
    [19, "10-19", "10–19"],
    [20, "20+", "20+"],
    [500, "20+", "20+"],
  ])("%i is %s, printed %s", (n, bucket, label) => {
    expect(liveCountBucket(n)).toBe(bucket)
    expect(liveCountLabel(liveCountBucket(n))).toBe(label)
  })

  it("prints an exact count as itself, for the host's copy of the same screen", () => {
    expect(liveCountLabel(7)).toBe("7")
  })
})

/** A host's snapshot of a twelve-person room, three of them gone quiet. */
function hostSnapshot(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    view: "host",
    eventId: "evt",
    at: "2026-10-01T20:00:00.000Z",
    inside: 12,
    guestsInside: 11,
    staffInside: 1,
    checkedInTotal: 14,
    checkedOutTotal: 2,
    staleInside: 3,
    capacity: 10,
    fillPct: 110,
    overCapacity: true,
    checkInRate10m: 6,
    medianRate10m: 3,
    messagesPerMinute: 1.4,
    activeChatters30m: 7,
    openFlags: 2,
    sentiment: { positive: 6, neutral: 3, negative: 1 },
    categories: [{ category: "entry_queue", count: 3 }],
    alerts: [
      {
        kind: "over_capacity",
        severity: "critical",
        title: "Over stated capacity",
        body: "11 guests against capacity 10 — 1 over. Staff aren't counted toward fill; 12 bodies are in the room.",
      },
    ],
    ...over,
  }
}

/** Every key in the payload whose value is a number, wherever it sits. */
function numericKeys(value: unknown, at = ""): string[] {
  if (typeof value === "number") return [at]
  if (Array.isArray(value)) return value.flatMap((v) => numericKeys(v, at))
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => numericKeys(v, at ? `${at}.${k}` : k))
  }
  return []
}

describe("forVenue", () => {
  const venue = forVenue(hostSnapshot())

  it("rounds every count of people to a range", () => {
    expect(venue).toMatchObject({
      view: "venue",
      inside: "10-19",
      guestsInside: "10-19",
      staffInside: "a_few",
      checkedInTotal: "10-19",
      checkedOutTotal: "a_few",
      staleInside: "a_few",
      checkInRate10m: "5-9",
      activeChatters30m: "5-9",
      sentiment: { positive: "5-9", neutral: "a_few", negative: "a_few" },
      categories: [{ category: "entry_queue", count: "a_few" }],
    })
  })

  it("leaves a number only where the venue already sees it: capacity, chat pace, the flag queue", () => {
    expect(numericKeys(venue).sort()).toEqual(["capacity", "messagesPerMinute", "openFlags"])
    // And those are the right numbers, not a count of people under an allowed name.
    expect(venue).toMatchObject({ capacity: 10, messagesPerMinute: 1.4, openFlags: 2 })
  })

  it("drops the figures nothing above rounds: fill, the median, the curve's totals", () => {
    expect(venue).not.toHaveProperty("fillPct")
    expect(venue).not.toHaveProperty("medianRate10m")
  })

  it("keeps the flags decided on the exact figures", () => {
    expect(venue.overCapacity).toBe(true)
    expect(forVenue(hostSnapshot({ overCapacity: false })).overCapacity).toBe(false)
    // 3 of 12 unseen is under half; 7 of 12 is over it.
    expect(venue.mostlyInferred).toBe(false)
    expect(forVenue(hostSnapshot({ staleInside: 7 })).mostlyInferred).toBe(true)
  })

  it("sends the alert without the counts in its body", () => {
    expect(venue.alerts).toEqual([
      {
        kind: "over_capacity",
        severity: "critical",
        title: "Over stated capacity",
        body: "More guests than the event's stated capacity.",
      },
    ])
    expect(JSON.stringify(venue.alerts)).not.toMatch(/\d/)
  })

  it("lets through only the fields it names, so a figure added later does not reach a venue", () => {
    const widened = { ...hostSnapshot(), uniqueAttendance: 14 } as LiveSnapshot
    expect(forVenue(widened)).not.toHaveProperty("uniqueAttendance")
  })
})

describe("alertsForVenue", () => {
  const KINDS: LiveAlertKind[] = [
    "safety",
    "entry_backing_up",
    "over_capacity",
    "approaching_capacity",
    "leaving_early",
    "mood_sliding",
    "room_died",
  ]
  const sent = alertsForVenue([
    ...KINDS.map((kind) => ({ id: kind, kind, body: "7 of 12 at 23:40" })),
    { id: "new", kind: "something_new", body: "7 people" },
  ])

  it("sends no alert that flips at an exact count the venue could work out, nor a kind it does not know", () => {
    expect(sent.map((a) => a.kind)).toEqual(["safety", "entry_backing_up", "over_capacity", "mood_sliding", "room_died"])
  })

  it("sends the rest as sentences with none of the night's figures in them", () => {
    for (const a of sent) expect(a.body).not.toMatch(/\b(7|12)\b|23:40/)
    // The issue it came from is otherwise intact: id, kind, times.
    expect(sent[0]).toMatchObject({ id: "safety", kind: "safety" })
  })
})
