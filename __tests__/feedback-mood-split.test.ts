import { discloseBreakdown, fewCount, type FewCount, type HeldTotal } from "@/lib/disclosure"
import { countLabel } from "@/lib/dashboard-format"
import { moodSplit } from "@/lib/feedback-digest"
import { venueMood } from "@/lib/venue-nights"

/**
 * The venue-day Feedback tab's mood split and the venue's "Nights here" row
 * are one disclosure (owner, 2026-11-14): a night must not read "8 positive ·
 * a few · a few" on one page and "held back" on the other. Hosts keep exact
 * mood. Brute-forced over 0–12 per mood, which spans zero, every few and the
 * floor on each side.
 */

const MAX = 12
type Moods = { positive: number; neutral: number; negative: number }
function* everyNight(): Generator<Moods> {
  for (let positive = 0; positive <= MAX; positive++)
    for (let neutral = 0; neutral <= MAX; neutral++)
      for (let negative = 0; negative <= MAX; negative++) yield { positive, neutral, negative }
}

const partsOf = (c: { positive: FewCount; neutral: FewCount; negative: FewCount }) => [c.positive, c.neutral, c.negative]

/**
 * Every hidden part a reader could pin down from what is shown. Nights that
 * print the same thing are grouped; within a group, each part shown as a few
 * must still be any of 1–4. One value left over is a part given back.
 */
function recoverable(disclose: (c: Moods) => { parts: FewCount[]; total: number | HeldTotal }): string[] {
  const groups = new Map<string, { parts: FewCount[]; seen: Set<number>[] }>()
  for (const c of everyNight()) {
    const shown = disclose(c)
    const key = JSON.stringify(shown)
    const group = groups.get(key) ?? { parts: shown.parts, seen: [new Set<number>(), new Set<number>(), new Set<number>()] }
    ;[c.positive, c.neutral, c.negative].forEach((n, i) => group.seen[i].add(n))
    groups.set(key, group)
  }
  const leaks: string[] = []
  for (const [key, { parts, seen }] of groups)
    parts.forEach((p, i) => {
      if (p === "few" && [...seen[i]].sort().join() !== "1,2,3,4") leaks.push(`${key} part ${i}: ${[...seen[i]].join()}`)
    })
  return leaks
}

const venueFeedback = (c: Moods) => {
  const split = moodSplit(c, "venue")
  return { parts: partsOf(split.counts), total: split.total }
}

describe("moodSplit: the venue's Feedback split is the Nights row's", () => {
  it("prints the same parts as Nights here for every night up to twelve a mood", () => {
    for (const c of everyNight()) {
      const nights = venueMood(c)
      const feedback = moodSplit(c, "venue")
      // Nothing classified: Nights has no mood, Feedback its empty state (total 0).
      expect(partsOf(feedback.counts)).toEqual(nights?.parts ?? [0, 0, 0])
      expect(partsOf(feedback.counts).map(countLabel)).toEqual((nights?.parts ?? [0, 0, 0]).map(countLabel))
      if (!nights) expect(feedback.total).toBe(0)
    }
  })

  it("reads the owner's night as Nights does: 8 positive, a few, a few, and a floor for the total", () => {
    const night = { positive: 8, neutral: 2, negative: 1 }
    expect(moodSplit(night, "venue")).toEqual({ counts: { positive: 8, neutral: "few", negative: "few" }, total: { atLeast: 10 } })
    expect(venueMood(night)?.parts).toEqual([8, "few", "few"])
    expect(partsOf(moodSplit(night, "venue").counts).map(countLabel)).toEqual(["8", "a few", "a few"])
    expect(countLabel(moodSplit(night, "venue").total)).toBe("10+")
    // The control: the breakdown rule this replaces held all three back on the same night.
    expect(discloseBreakdown([8, 2, 1]).cells).toEqual([null, null, null])
  })

  it("never gives a hidden mood back: each few is still any of one to four, the total included", () => {
    expect(recoverable(venueFeedback)).toEqual([])
    // The staging night of step 15: 19 neutral and 1 positive. The total is a floor, so it cannot be subtracted.
    expect(moodSplit({ positive: 1, neutral: 19, negative: 0 }, "venue")).toEqual({
      counts: { positive: "few", neutral: 19, negative: 0 },
      total: { atLeast: 20 },
    })
    for (const c of everyNight()) {
      const { counts, total } = moodSplit(c, "venue")
      if (partsOf(counts).includes("few")) expect(typeof total).toBe("object")
    }
  })

  it("catches a leak when there is one (control: an exact total beside the few)", () => {
    const leaky = (c: Moods) => ({ parts: [c.positive, c.neutral, c.negative].map(fewCount), total: c.positive + c.neutral + c.negative })
    const leaks = recoverable(leaky)
    expect(leaks.length).toBeGreaterThan(0)
    expect(leaks.some((l) => l.startsWith(JSON.stringify({ parts: ["few", 19 - 7, 0], total: 13 })))).toBe(true)
  })
})

describe("moodSplit: a host's split is unchanged", () => {
  it("is every mood exact and their sum, few or not", () => {
    for (const c of everyNight()) {
      expect(moodSplit(c, "host")).toEqual({ counts: c, total: c.positive + c.neutral + c.negative })
    }
  })
})
