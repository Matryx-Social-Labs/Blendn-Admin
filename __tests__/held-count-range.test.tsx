// A db the frozen-tally case fills in; nothing else here reads it.
const mockDb: Record<string, Record<string, jest.Mock>> = {}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/rating-batches", () => ({ publishedRatingGroups: async () => [] }))

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { NightMoodPanel } from "@/components/dashboard/event-insights-panels"
import { countLabel, splitShares } from "@/lib/dashboard-format"
import { discloseCategories, discloseNegatives, type CountRange, type DisclosedCategory } from "@/lib/disclosure"
import { buildFeedbackDigest, moodSplit, tallyFeedback, type TallyRow } from "@/lib/feedback-digest"
import { deriveAlerts, type LiveFigures } from "@/lib/live-metrics"

/*
 * A held-back complaint count cannot be worked out by subtraction (SCRUM-1441, register D-012).
 *
 * A host reads the exact negative total and the count of every category that clears the floor. With exactly one
 * category held back, total minus shown is the held one: negative 27, crowding 7, entry_queue "<5" → 20. So in that
 * state the negative count, and the total it is part of, are a band of five aligned on the shown negatives: the held
 * count is only ever known to be one of five values, and the band moves in steps of five, never one-for-one with it.
 * The split bar and the mood alert read the band's midpoint, so they give nothing back either.
 */

const ROOM = 40

/** `messages[i]` messages of `sentiment` in `category` from person i. */
const rows = (category: string, messages: number[], sentiment: TallyRow["sentiment"] = "negative"): TallyRow[] =>
  messages.flatMap((n, i) =>
    Array.from({ length: n }, () => ({ sentiment, category: category as TallyRow["category"], topic: null, userId: `${category}-${i}` }))
  )

/** What a host is shown of one night: the split, the categories, the bar, and the mood alert's words. */
function hostView(feedback: TallyRow[]) {
  const t = tallyFeedback(feedback)
  const categories = discloseCategories(t.categoryCounts, t.contributors, ROOM, t.topMessages)
  const negative = discloseNegatives(t.counts.negative, categories, t.negatives)
  const split = moodSplit(t.counts, "host", negative)
  return { ...split, categories, negative }
}

/** The night in the ticket: 25 positive, 9 neutral, 27 negative; crowding 7 shown, entry_queue 20 held (dominated). */
const ticketNight = [
  ...rows("other", [5, 5, 5, 5, 5], "positive"),
  ...rows("other", [3, 3, 3], "neutral"),
  ...rows("entry_queue", [16, 1, 1, 1, 1]),
  ...rows("crowding", [2, 2, 1, 1, 1]),
]

const liveFigures = (sentiment: LiveFigures["sentiment"]): LiveFigures => ({
  eventId: "evt",
  at: "2026-08-05T22:45:00.000Z",
  inside: 40,
  guestsInside: 38,
  staffInside: 2,
  checkedInTotal: 45,
  checkedOutTotal: 5,
  unconfirmed: 0,
  capacity: 80,
  fillPct: 48,
  overCapacity: false,
  checkInRate10m: 8,
  medianRate10m: 8,
  messagesPerMinute: 2,
  activeChatters30m: 12,
  openFlags: 0,
  sentiment,
  categories: [],
})
const moodAlert = (sentiment: LiveFigures["sentiment"]) =>
  deriveAlerts(liveFigures(sentiment), { scheduledEnd: new Date("2026-08-05T23:59:00.000Z"), now: new Date("2026-08-05T22:45:00.000Z") }).find((a) => a.kind === "mood_sliding") ?? null

/** Every number a string or a payload carries, so "nothing equals 20" is checked on all of them. */
const numbersIn = (value: unknown): number[] => (JSON.stringify(value).match(/\d+(?:\.\d+)?/g) ?? []).map(Number)

describe("the night in the ticket (negative 27, crowding 7 shown, entry_queue held)", () => {
  const view = hostView(ticketNight)

  it("holds entry_queue back and shows crowding", () => {
    expect(view.categories).toEqual([
      { category: "crowding", count: 7, suppressed: false },
      { category: "entry_queue", count: null, suppressed: true },
    ])
  })

  it("shows the negatives as a band of five and the total with it, positive and neutral exact", () => {
    expect(view.counts).toEqual({ positive: 25, neutral: 9, negative: { min: 23, max: 27 } })
    expect(view.total).toEqual({ min: 57, max: 61 })
    expect(countLabel(view.counts.negative)).toBe("23–27")
    expect(countLabel(view.total)).toBe("57–61")
    // Long-text proof: a band of a big night keeps its separators.
    expect(countLabel({ min: 12476, max: 12480 })).toBe("12,476–12,480")
  })

  it("gives the held count back nowhere: not in the digest's split, the bar, the panel or the alert", () => {
    const shares = splitShares([view.counts.positive, view.counts.neutral, view.counts.negative])
    const panel = renderToStaticMarkup(createElement(NightMoodPanel, { mood: { counts: view.counts, total: view.total, categories: view.categories, topics: [] }, live: false, eventId: "evt" }))
    const alert = moodAlert({ positive: 25, neutral: 9, negative: view.negative })
    // Nothing equals it, and nothing is the exact negative (27) or total (61) on its own: those minus the shown 7 are it.
    // A band's edge is not the figure: 23–27 less 7 is 16–20, five values (the grid below proves it for every night).
    const exact = (c: unknown) => (typeof c === "number" ? [c] : [])
    const withoutBands = (s: string | undefined) => numbersIn((s ?? "").replace(/<[^>]*>/g, " ").replace(/[\d,]+–[\d,]+/g, ""))
    const figures = [
      ...exact(view.counts.positive),
      ...exact(view.counts.neutral),
      ...exact(view.counts.negative),
      ...exact(view.total),
      ...view.categories.flatMap((c) => exact(c.count)),
      ...(shares ?? []),
      ...withoutBands(panel),
      ...withoutBands(alert?.body),
    ]
    expect(figures).not.toContain(20)
    expect(figures).not.toContain(27)
    expect(figures).not.toContain(61)
    expect(panel).toContain("23–27 negative")
    expect(panel).toContain("57–61 classified msgs")
  })

  it("draws the bar and decides the alert on the band's midpoint, never the exact count", () => {
    const shares = splitShares([25, 9, view.counts.negative])
    expect(shares).toEqual(splitShares([25, 9, 25]))
    expect(moodAlert({ positive: 25, neutral: 9, negative: view.negative })).toEqual(
      expect.objectContaining({ body: "23–27 of 57–61 classified messages in the last 30 minutes are negative." })
    )
  })
})

describe("after the 180-day purge (a frozen tally)", () => {
  /*
   * The purge keeps every feedback row and nulls its message (`lib/lobby-retention.ts`), so the negatives per category
   * still come from the rows; who raised them comes from the frozen tally. The band is the one the live rows gave.
   */
  const digestOf = async (rowsRead: object[], frozen: object | null) => {
    Object.assign(mockDb, {
      event_ratings: { count: jest.fn().mockResolvedValue(0) },
      event_feedback: { findMany: jest.fn().mockResolvedValue(rowsRead) },
      chat_group_members: { count: jest.fn().mockResolvedValue(ROOM) },
      event_feedback_tallies: { findUnique: jest.fn().mockResolvedValue(frozen) },
    })
    const d = await buildFeedbackDigest({ id: "evt", title: "night", end_time: new Date("2026-05-01T22:00:00Z"), timezone: "UTC" }, "host", null)
    return { counts: d.counts, total: d.total, categories: d.categories }
  }

  it("gives the same band as the live rows did", async () => {
    const live = ticketNight.map((r) => ({ sentiment: r.sentiment, category: r.category, topic: r.topic, message: { user_id: r.userId } }))
    const t = tallyFeedback(ticketNight)
    const frozen = {
      population: ROOM,
      contributors: Object.fromEntries(t.contributors),
      topics: Object.fromEntries(t.topics),
      top_messages: Object.fromEntries(t.topMessages),
    }
    const before = await digestOf(live, null)
    const after = await digestOf(live.map((r) => ({ ...r, message: null })), frozen)
    expect(before.counts.negative).toEqual({ min: 23, max: 27 })
    expect(after).toEqual(before)
  })
})

describe("the mood alert on a band", () => {
  it("decides on the midpoint, not the band's top: 20 positive, 9 neutral, 17–21 negative (19 of 48 is 39.6%; 21 of 50 would be 42%)", () => {
    expect(moodAlert({ positive: 20, neutral: 9, negative: { min: 17, max: 21 } })).toBeNull()
  })
  it("fires once the midpoint reaches 40%: 18 positive, 9 neutral, 16–20 negative (18 of 45)", () => {
    expect(moodAlert({ positive: 18, neutral: 9, negative: { min: 16, max: 20 } })?.body).toBe("16–20 of 43–47 classified messages in the last 30 minutes are negative.")
  })
})

describe("the rule, on its own", () => {
  const held = (category: string): DisclosedCategory => ({ category, count: null, suppressed: true })
  const shown = (category: string, count: number): DisclosedCategory => ({ category, count, suppressed: false })

  it("leaves the negatives exact when nothing is held", () => {
    expect(discloseNegatives(27, [shown("crowding", 7), shown("entry_queue", 20)], new Map([["crowding", 7], ["entry_queue", 20]]))).toBe(27)
  })

  it("leaves them exact when two are held: only their sum can be worked out, as before", () => {
    expect(discloseNegatives(27, [shown("crowding", 7), held("entry_queue"), held("facilities")], new Map([["crowding", 7], ["entry_queue", 18], ["facilities", 2]]))).toBe(27)
  })

  it("bands them when the held category is the only one (nothing shown to subtract, the band is the negatives)", () => {
    expect(discloseNegatives(3, [held("safety_conduct")], new Map([["safety_conduct", 3]]))).toEqual({ min: 1, max: 5 })
  })

  it("leaves them exact when the one held category has no negatives (an escalating category of other moods)", () => {
    expect(discloseNegatives(7, [shown("crowding", 7), held("safety_conduct")], new Map([["crowding", 7], ["safety_conduct", 0]]))).toBe(7)
  })
})

/*
 * The grid, as feedback-mood-split.test.ts does for the venue split: every night a host could be shown, grouped by
 * everything printed. Within a group, the held count must still be any of at least five values (`MIN_CELL`, the floor's
 * width), whatever combination of figures the host does arithmetic on, because every figure is the group's.
 */
describe("over every night (positive, neutral 0–6; shown negatives 0–12; held negatives 1–40)", () => {
  const MAX_HELD = 40
  type Night = { positive: number; neutral: number; shownNeg: number; heldNeg: number }
  function* nights(): Generator<Night> {
    for (let positive = 0; positive <= 6; positive += 3)
      for (let neutral = 0; neutral <= 6; neutral += 3)
        for (let shownNeg = 0; shownNeg <= 12; shownNeg++)
          for (let heldNeg = 1; heldNeg <= MAX_HELD; heldNeg++) yield { positive, neutral, shownNeg, heldNeg }
  }
  const printed = (n: Night) => {
    const categories: DisclosedCategory[] = [
      ...(n.shownNeg > 0 ? [{ category: "crowding", count: n.shownNeg, suppressed: false }] : []),
      { category: "entry_queue", count: null, suppressed: true },
    ]
    const negative = discloseNegatives(n.shownNeg + n.heldNeg, categories, new Map([["crowding", n.shownNeg], ["entry_queue", n.heldNeg]]))
    // The band always holds the true count: it hides the figure, it never misstates it.
    if (typeof negative !== "number") expect([negative.min <= n.shownNeg + n.heldNeg, n.shownNeg + n.heldNeg <= negative.max]).toEqual([true, true])
    const split = moodSplit({ positive: n.positive, neutral: n.neutral, negative: n.shownNeg + n.heldNeg }, "host", negative)
    return {
      split,
      categories,
      bar: splitShares([split.counts.positive, split.counts.neutral, split.counts.negative]),
      alert: moodAlert({ positive: n.positive, neutral: n.neutral, negative }),
    }
  }

  it("never narrows the held count below five values, and every band is five wide", () => {
    const groups = new Map<string, Set<number>>()
    for (const n of nights()) {
      const key = JSON.stringify(printed(n))
      groups.set(key, (groups.get(key) ?? new Set<number>()).add(n.heldNeg))
    }
    const narrowed = [...groups].filter(([, held]) => held.size < 5 && Math.min(...held) <= MAX_HELD - 4)
    expect(narrowed).toEqual([])
    for (const [, held] of groups) expect(Math.max(...held) - Math.min(...held)).toBeLessThanOrEqual(4)
  })

  it("moves the band in steps of five: one more held negative changes nothing printed until a fifth", () => {
    const a = printed({ positive: 3, neutral: 3, shownNeg: 7, heldNeg: 16 })
    expect(printed({ positive: 3, neutral: 3, shownNeg: 7, heldNeg: 20 })).toEqual(a)
    expect(printed({ positive: 3, neutral: 3, shownNeg: 7, heldNeg: 21 })).not.toEqual(a)
  })

  it("with nothing held, prints every figure exactly as today", () => {
    const negative = discloseNegatives(27, [{ category: "crowding", count: 27, suppressed: false }], new Map([["crowding", 27]]))
    expect(moodSplit({ positive: 25, neutral: 9, negative: 27 }, "host", negative)).toEqual({ counts: { positive: 25, neutral: 9, negative: 27 }, total: 61 })
  })
})

describe("the venue's split", () => {
  it("is unchanged: the band is a host's, and a venue's goes through discloseGroup as before (subtraction path: SCRUM-1441 follow-up)", () => {
    const range: CountRange = { min: 23, max: 27 }
    expect(moodSplit({ positive: 25, neutral: 9, negative: 27 }, "venue", range)).toEqual({ counts: { positive: 25, neutral: 9, negative: 27 }, total: 61 })
  })
})
