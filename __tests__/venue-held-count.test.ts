// The db the digest reads; each case fills it in.
const mockDb: Record<string, Record<string, jest.Mock>> = {}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/rating-batches", () => ({ publishedRatingGroups: async () => [] }))

import { discloseCategories, discloseNegatives, midpoint } from "@/lib/disclosure"
import { buildFeedbackDigest, tallyFeedback, type TallyRow } from "@/lib/feedback-digest"
import { forVenue, type LiveSnapshot } from "@/lib/live-metrics"
import { venueMood } from "@/lib/venue-nights"

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

/** The host's live snapshot of the same rows, as `buildLiveSnapshot` makes it, for `forVenue` to round. */
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

/** Every venue surface for one night: the Feedback tab, the Nights here row, the Live tab and Room tonight's word. */
async function venueSurfaces(feedback: TallyRow[]) {
  const live = forVenue(hostSnapshot(feedback))
  const t = tallyFeedback(feedback)
  return {
    feedbackTab: await venueDigest(feedback),
    nightsHere: venueMood(t.counts),
    live: { sentiment: live.sentiment, raised: live.raised },
    tonight: venueMood({ ...hostSnapshot(feedback).sentiment, negative: midpoint(hostSnapshot(feedback).sentiment.negative) })?.word ?? "quiet",
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
    expect(forVenue(hostSnapshot(ticketNight))).not.toHaveProperty("categories")
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
   * Accepted, and recorded under D-012 (advisor, 2026-11-27): a listed category is at least one message, so on a night
   * with fewer than five negatives beyond the other listed categories' one each, the held count is "one up to what is
   * left". That is the whole range a listing allows, never a narrower one; the alternative is hiding a raised category,
   * which loses "a safety concern was raised".
   */
  it("never narrows the held count below five values, beyond each listed category being at least one", async () => {
    const groups = new Map<string, Set<number>>()
    for (const n of nights()) {
      const key = JSON.stringify(await venueSurfaces(feedbackOf(n)))
      groups.set(key, (groups.get(key) ?? new Set<number>()).add(n.held))
    }
    const onlyAtLeastOne = (held: Set<number>) => Math.min(...held) === 1 && Math.max(...held) === held.size
    const narrowed = [...groups].filter(([, held]) => held.size < 5 && !onlyAtLeastOne(held) && Math.min(...held) <= MAX_HELD - 4)
    expect(narrowed.map(([key, held]) => ({ key, held: [...held] }))).toEqual([])
  })
})
