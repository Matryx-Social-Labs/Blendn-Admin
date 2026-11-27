import { compactCount, hereRange, hereSentence } from "@/lib/dashboard-format"
import { liveCountBucket, liveCountLabel } from "@/lib/disclosure"
import { CONFIRMED_WINDOW_MINUTES } from "@/lib/presence"

/*
 * The host's "in the room" as a range (SCRUM-1328, design/09).
 *
 * Pings are foreground only, so `inside` means "arrived and not seen leaving".
 * The low end is who was seen, or checked in, within the confirmed window; the
 * high end is everyone checked in. One formatter for every place a host reads
 * the room (the Live hero, the Overview's live banner), so the two cannot
 * disagree. Picks: artefacts/09-count-range/CHAIN.md.
 */

describe("compactCount", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1k"],
    [1250, "1.2k"],
    [1299, "1.2k"],
    [9960, "9.9k"],
    [10_000, "10k"],
    [12_480, "12k"],
    [9_999, "9.9k"],
    [99_999, "99k"],
    [999_999, "999k"],
    [1_000_000, "1M"],
    [1_250_000, "1.2M"],
  ])("%i reads %s: exact to 999, then compact, rounded down", (n, shown) => {
    expect(compactCount(n)).toBe(shown)
  })
})

describe("hereRange", () => {
  it("is the seen figure to everyone checked in, with an en dash", () => {
    expect(hereRange(3, 1)).toEqual({ label: "2–3", spoken: "2 to 3 people here" })
    expect(hereRange(52, 14)).toEqual({ label: "38–52", spoken: "38 to 52 people here" })
  })

  it("is one number when everybody was seen", () => {
    expect(hereRange(52, 0)).toEqual({ label: "52", spoken: "52 people here" })
    expect(hereRange(0, 0)).toEqual({ label: "0", spoken: "0 people here" })
    expect(hereRange(1, 0)).toEqual({ label: "1", spoken: "1 person here" })
    expect(hereRange(1, 1)).toEqual({ label: "0–1", spoken: "0 to 1 person here" })
  })

  it("starts at 0 when nobody was seen", () => {
    expect(hereRange(52, 52)).toEqual({ label: "0–52", spoken: "0 to 52 people here" })
  })

  it("is compact past 999 and says the full numbers aloud", () => {
    expect(hereRange(12_480, 2_520)).toEqual({ label: "9.9k–12k", spoken: "9,960 to 12,480 people here" })
  })

  it("is one compact figure when both ends compact alike, and still says both", () => {
    expect(hereRange(12_480, 100)).toEqual({ label: "12k", spoken: "12,380 to 12,480 people here" })
  })

  it("is exact under the floors, as the host's figure is today; the venue's rounding is its own", () => {
    // The host's hero has never held back its own room's count: under five it is exact.
    expect(hereRange(4, 1).label).toBe("3–4")
    // The venue's copy goes through the bucket, never through the range.
    expect(liveCountLabel(liveCountBucket(4))).toBe("Under 5")
  })
})

describe("hereSentence", () => {
  const W = CONFIRMED_WINDOW_MINUTES

  it("says what the low end is", () => {
    expect(hereSentence(52, 14)).toBe(
      `38 were seen in the last ${W} minutes; the other 14 are still checked in, but their phones have gone quiet, as phones in pockets do.`
    )
  })

  it("says one person in the singular", () => {
    expect(hereSentence(3, 1)).toBe(
      `2 were seen in the last ${W} minutes; the other one is still checked in, but their phone has gone quiet, as phones in pockets do.`
    )
    expect(hereSentence(2, 1)).toBe(
      `1 was seen in the last ${W} minutes; the other one is still checked in, but their phone has gone quiet, as phones in pockets do.`
    )
  })

  it("says everyone when the ends meet", () => {
    expect(hereSentence(52, 0)).toBe(`Everyone here was seen in the last ${W} minutes.`)
  })

  it("says nobody when nobody was seen", () => {
    expect(hereSentence(52, 52)).toBe(
      `Nobody was seen in the last ${W} minutes; all 52 are still checked in, but their phones have gone quiet, as phones in pockets do.`
    )
  })

  it("says one person who went quiet in the singular", () => {
    expect(hereSentence(1, 1)).toBe(
      `Nobody was seen in the last ${W} minutes; the one person here is still checked in, but their phone has gone quiet, as phones in pockets do.`
    )
  })

  it("says nothing about an empty room", () => {
    expect(hereSentence(0, 0)).toBe("")
  })

  it("writes the full numbers, even when the figure above it is compact", () => {
    expect(hereSentence(12_480, 2_520)).toContain("9,960 were seen")
    expect(hereSentence(12_480, 2_520)).toContain("the other 2,520 are")
  })
})
