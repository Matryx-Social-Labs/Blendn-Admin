// The db the digest reads; each case fills it in.
const mockDb: Record<string, Record<string, jest.Mock>> = {}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/rating-batches", () => ({ publishedRatingGroups: async () => [] }))
// Room tonight's read of the live snapshot, and its offers (none: the venue below has no owner org).
const mockRead = jest.fn()
jest.mock("@/lib/live-snapshot", () => ({ readLiveSnapshot: (...a: unknown[]) => mockRead(...a) }))
jest.mock("@/lib/offers/venue", () => ({ redeemedByNight: async () => new Map() }))

import { discloseCategories, discloseNegatives, raisedCategories, type DisclosedCategory } from "@/lib/disclosure"
import { buildFeedbackDigest, tallyFeedback, type TallyRow } from "@/lib/feedback-digest"
import { forVenue, type LiveSnapshot } from "@/lib/live-metrics"
import { venueMood } from "@/lib/venue-nights"
import { venueTonight } from "@/lib/venue-room-tonight"

/*
 * A venue cannot work out a held-back complaint count either (SCRUM-1500, the venue half of register D-012).
 *
 * A venue owner reading another host's night was shown the negatives exactly from five up (the Feedback tab and the
 * "Nights here" row print them alike) and, beside them, every complaint category's count or "<5": negative 27,
 * crowding 7, entry_queue held → 20. Now no venue surface carries a per-category number at all: the Feedback tab and
 * the live snapshot name the categories raised, in one fixed order, safety first. What is left to subtract from is the
 * split, which holds only the categories' sum.
 */

const ROOM = 40

/** `messages[i]` messages of `sentiment` in `category` from person i. */
const rows = (category: string, messages: number[], sentiment: TallyRow["sentiment"] = "negative"): TallyRow[] =>
  messages.flatMap((n, i) =>
    Array.from({ length: n }, () => ({ sentiment, category: category as TallyRow["category"], topic: null, userId: `${category}-${i}` }))
  )

/** The venue's Feedback tab: the digest in the venue view, built from these rows. */
async function venueDigest(feedback: TallyRow[]) {
  Object.assign(mockDb, {
    event_ratings: { count: jest.fn().mockResolvedValue(0) },
    event_feedback: {
      findMany: jest.fn().mockResolvedValue(feedback.map((r) => ({ sentiment: r.sentiment, category: r.category, topic: r.topic, message: { user_id: r.userId } }))),
    },
    chat_group_members: { count: jest.fn().mockResolvedValue(ROOM) },
    event_feedback_tallies: { findUnique: jest.fn().mockResolvedValue(null) },
  })
  const d = await buildFeedbackDigest({ id: "evt", title: "night", end_time: new Date("2026-05-01T22:00:00Z"), timezone: "UTC" }, "venue", 1)
  // Everything it says about people and messages; the dates and the title are the event's own.
  const { view, counts, total, categories, raised, topics, ratings, averageRating, ratingCount, ratingsTowardNextUpdate, messages, messagesTotal } = d
  return { view, counts, total, categories, raised, topics, ratings, averageRating, ratingCount, ratingsTowardNextUpdate, messages, messagesTotal }
}

/** The host's live snapshot of the same rows, as `readLiveSnapshot` makes it, for `forVenue` to round. */
function hostSnapshot(feedback: TallyRow[]): LiveSnapshot {
  const t = tallyFeedback(feedback)
  const categories = discloseCategories(t.categoryCounts, t.contributors, ROOM, t.topMessages)
  return {
    view: "host",
    social: null,
    topics: [],
    eventId: "evt",
    at: "2026-05-01T21:30:00.000Z",
    inside: 30,
    guestsInside: 28,
    staffInside: 2,
    checkedInTotal: 36,
    checkedOutTotal: 6,
    unconfirmed: 0,
    capacity: 80,
    fillPct: 38,
    overCapacity: false,
    checkInRate10m: 4,
    medianRate10m: 4,
    messagesPerMinute: 2,
    activeChatters30m: 12,
    openFlags: 0,
    sentiment: { ...t.counts, negative: discloseNegatives(t.counts.negative, categories, t.negatives) },
    categories,
    alerts: [],
  }
}

/**
 * Every venue surface for one night with a figure: the Feedback tab, the Nights here row and the Live tab. Room
 * tonight's word on another host's night reads the same exact negatives (tested on its own below), so adds nothing.
 */
async function venueSurfaces(feedback: TallyRow[]) {
  const t = tallyFeedback(feedback)
  // `readLiveSnapshot` hands the venue's copy the window's exact negatives, never the host's band.
  const live = forVenue(hostSnapshot(feedback), t.counts.negative)
  return {
    feedbackTab: await venueDigest(feedback),
    nightsHere: venueMood(t.counts),
    live: { sentiment: live.sentiment, raised: live.raised },
  }
}

/** Every number a payload carries, wherever it sits (a bucket such as "20+" is a range, not a figure). */
const numbersIn = (value: unknown): number[] =>
  typeof value === "number" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(numbersIn) : []

/** The night in the ticket: 25 positive, 9 neutral, 27 negative; crowding 7 shown, entry_queue 20 held (dominated). */
const ticketNight = [
  ...rows("other", [5, 5, 5, 5, 5], "positive"),
  ...rows("other", [3, 3, 3], "neutral"),
  ...rows("entry_queue", [16, 1, 1, 1, 1]),
  ...rows("crowding", [2, 2, 1, 1, 1]),
]

describe("the night in the ticket, as a venue (negative 27, crowding 7 shown, entry_queue held)", () => {
  it("names the categories raised, in the fixed order, with no count on any venue surface", async () => {
    const s = await venueSurfaces(ticketNight)
    expect(s.feedbackTab.categories).toEqual([])
    expect(s.feedbackTab.raised).toEqual(["entry_queue", "crowding"])
    expect(s.live.raised).toEqual(["entry_queue", "crowding"])
    expect(forVenue(hostSnapshot(ticketNight), 27)).not.toHaveProperty("categories")
  })

  it("keeps the split as Nights here prints it: the categories' sum, nothing to subtract from it", async () => {
    const s = await venueSurfaces(ticketNight)
    expect(s.feedbackTab.counts).toEqual({ positive: 25, neutral: 9, negative: 27 })
    expect(s.nightsHere?.parts).toEqual([25, 9, 27])
  })

  it("carries neither the held count (20) nor the shown one it is subtracted around (7), anywhere", async () => {
    const figures = numbersIn(await venueSurfaces(ticketNight))
    expect(figures).not.toContain(20)
    expect(figures).not.toContain(7)
  })

  it("puts safety first whatever was said most, and lists the rest in the taxonomy's order", async () => {
    const night = [...rows("crowding", [3, 3, 3, 3, 3]), ...rows("safety_conduct", [1]), ...rows("facilities", [1, 1, 1, 1, 1, 1])]
    const s = await venueSurfaces(night)
    expect(s.feedbackTab.raised).toEqual(["safety_conduct", "crowding", "facilities"])
    expect(s.live.raised).toEqual(["safety_conduct", "crowding", "facilities"])
  })
})

describe("when the names alone would pin a held count", () => {
  it("names nothing when the held category is the only one raised: 12 negatives, all entry_queue, held", async () => {
    const s = await venueSurfaces(rows("entry_queue", [12]))
    expect(s.feedbackTab.counts.negative).toBe(12)
    expect(s.feedbackTab.raised).toEqual([])
    expect(s.live.raised).toEqual([])
  })

  it("names nothing when the others leave a held one under five values: 5 negatives over two held categories", async () => {
    // Each named category is at least one, so either would be 1–4 of 5. (A shown category has five or more, so beside
    // one the rest always keep five values.)
    const night = [...rows("entry_queue", [4]), ...rows("facilities", [1])]
    const s = await venueSurfaces(night)
    expect(s.feedbackTab.raised).toEqual([])
    expect(s.live.raised).toEqual([])
  })

  it("still names a lone category that is shown: its count clears the floor, and the host reads it exactly", async () => {
    const s = await venueSurfaces(rows("crowding", [2, 2, 2, 1, 1]))
    expect(s.feedbackTab.raised).toEqual(["crowding"])
  })

  it("still names them under five negatives: the venue reads only \"a few\", nothing to subtract from", async () => {
    const s = await venueSurfaces(rows("entry_queue", [3]))
    expect(s.feedbackTab.counts.negative).toBe("few")
    expect(s.feedbackTab.raised).toEqual(["entry_queue"])
  })
})

describe("raisedCategories, on its own", () => {
  const held = (category: string): DisclosedCategory => ({ category, count: null, suppressed: true })
  const shown = (category: string, count: number): DisclosedCategory => ({ category, count, suppressed: false })

  it("puts a category the taxonomy does not know last, by name", () => {
    expect(raisedCategories([shown("zeta", 9), shown("alpha", 9), shown("crowding", 5), held("safety_conduct")], 30)).toEqual(["safety_conduct", "crowding", "alpha", "zeta"])
  })

  it("withholds at four values left and names at five: k names leave a held one 1 to negative − k + 1", () => {
    expect(raisedCategories([held("entry_queue"), held("facilities")], 5)).toEqual([])
    expect(raisedCategories([held("entry_queue"), held("facilities")], 6)).toEqual(["entry_queue", "facilities"])
  })

  it("names a held category raised alone when the venue reads only \"a few\" negatives", () => {
    expect(raisedCategories([held("entry_queue")], "few")).toEqual(["entry_queue"])
    expect(raisedCategories([held("entry_queue")], 12)).toEqual([])
  })

  it("never withholds when nothing is held: no count to protect", () => {
    expect(raisedCategories([shown("crowding", 5)], 5)).toEqual(["crowding"])
  })
})

describe("the venue's mood alert (forVenue)", () => {
  // 5 positive, 4 neutral, the host's band 6–10: on its middle (8 of 17, 47%) the alert fires. Exact 5 (5 of 14, 36%)
  // does not; exact 9 (9 of 18, 50%) does.
  const snapshot = (): LiveSnapshot => ({
    ...hostSnapshot([]),
    sentiment: { positive: 5, neutral: 4, negative: { min: 6, max: 10 } },
    alerts: [{ kind: "mood_sliding", severity: "warning", title: "Mood sliding", body: "6–10 of 15–19 classified messages in the last 30 minutes are negative." }],
  })

  it("is decided again on the exact negatives, not the band's middle", () => {
    expect(forVenue(snapshot(), 5).alerts.map((a) => a.kind)).not.toContain("mood_sliding")
    expect(forVenue({ ...snapshot(), alerts: [] }, 9).alerts).toEqual([expect.objectContaining({ kind: "mood_sliding", body: "Most of the recent classified messages are negative." })])
  })
})

describe("Room tonight's mood word (venue-room-tonight.ts)", () => {
  // 10 positive, the exact 16 negative: "mostly negative". The host's band 12–16 (midpoint 14) reads "mixed".
  const room = (organizer_org_id: string) => [{ id: "evt", kind: "event", organizer_org_id, organizer_org: { display_name: "Host" }, organizer: null }]
  const tonight = async (organizer_org_id: string) => {
    mockDb.events = { findMany: jest.fn().mockResolvedValue(room(organizer_org_id)) }
    mockRead.mockResolvedValue({
      snapshot: { guestsInside: 30, checkInRate10m: 4, social: null, sentiment: { positive: 10, neutral: 0, negative: { min: 12, max: 16 } } },
      negatives: 16,
    })
    const venue = { id: "v1", owner_org_id: null, claimed_at: new Date("2026-01-01T00:00:00Z"), timezone: "Asia/Kolkata", day_reset_hour: 6 }
    return (await venueTonight(venue, { id: "owner", orgIds: ["org-venue"] }))?.mood
  }

  it("reads another host's night from the exact negatives, as the venue reads the night", async () => {
    expect(await tonight("org-host")).toBe("mostly negative")
  })

  it("reads a night its own organisation hosts from the band's middle, as that night's host does", async () => {
    expect(await tonight("org-venue")).toBe("mixed")
  })
})

/*
 * The grid, as held-count-range.test.ts does for the host: every night a venue could be shown, grouped by everything
 * printed on every venue surface together. Within a group the held count must still be any of at least five values,
 * whatever arithmetic the venue does across the four surfaces.
 */
describe("over every night (positive, neutral 0/3/6; crowding 0–14; held entry_queue 1–40)", () => {
  const MAX_HELD = 40
  type Night = { positive: number; neutral: number; shown: number; held: number }
  function* nights(): Generator<Night> {
    for (const positive of [0, 3, 6])
      for (const neutral of [0, 3, 6])
        for (let shown = 0; shown <= 14; shown++)
          for (let held = 1; held <= MAX_HELD; held++) yield { positive, neutral, shown, held }
  }
  /**
   * Crowding spread evenly over up to five people, so from five messages it clears the floor and under five it is held
   * too (the venue cannot tell which); entry_queue from one person, so it is always held.
   */
  const spread = (count: number) => Array.from({ length: Math.min(count, 5) }, (_, i) => Math.floor(count / 5) + (i < count % 5 ? 1 : 0) || 1)
  const feedbackOf = (n: Night): TallyRow[] => [
    ...rows("other", n.positive ? [n.positive] : [], "positive"),
    ...rows("other", n.neutral ? [n.neutral] : [], "neutral"),
    ...rows("crowding", spread(n.shown)),
    ...rows("entry_queue", [n.held]),
  ]

  /*
   * Under five negatives the venue reads "a few" and the held count is one to four: the floor's own statement, all
   * a listing allows. A group that names no category says nothing about entry_queue's count beyond "not named" (the
   * accepted residual, `raisedCategories`), so only groups that name it must leave it five values.
   */
  it("never narrows a named held count below five values", async () => {
    const groups = new Map<string, Set<number>>()
    for (const n of nights()) {
      const key = JSON.stringify(await venueSurfaces(feedbackOf(n)))
      groups.set(key, (groups.get(key) ?? new Set<number>()).add(n.held))
    }
    const onlyAtLeastOne = (held: Set<number>) => Math.min(...held) === 1 && Math.max(...held) === held.size
    const named = (key: string) => key.includes("entry_queue")
    const narrowed = [...groups].filter(([key, held]) => named(key) && held.size < 5 && !onlyAtLeastOne(held) && Math.min(...held) <= MAX_HELD - 4)
    // And the withheld state is reached, so the filter above is not vacuous.
    expect([...groups.keys()].some((key) => !named(key))).toBe(true)
    expect(narrowed.map(([key, held]) => ({ key, held: [...held] }))).toEqual([])
  })
})
