import { discloseGroup, MIN_CELL } from "@/lib/disclosure"
import { MIN_ATTENDEES } from "@/lib/connection-metrics"
import { cameBand, crewsCell, metRange, MET_RANGES, offersBand, ratingCell, venueMood } from "@/lib/venue-nights"

/**
 * What a venue is told of a night (Venue C, SCRUM-1051, approvals 8 and 9):
 * bands and plain words, never a count of people under the floor, and nothing
 * about meeting on a night another host runs (that is the page's "host's").
 */

describe("metRange: met someone, as a venue reads its own night", () => {
  it("is held below the pairs floor, as the host's figure is", () => {
    expect(metRange(0, MIN_ATTENDEES - 1)).toBe("held")
    expect(metRange(6, MIN_ATTENDEES - 1)).toBe("held")
    // The control: at the floor it is a range.
    expect(metRange(4, MIN_ATTENDEES)).toBe("about half")
  })

  it("is a word, never a number, and the words go up with the share", () => {
    expect(metRange(0, 40)).toBe("nobody")
    expect(metRange(2, 40)).toBe("under a quarter")
    expect(metRange(4, 20)).toBe("under a quarter")
    expect(metRange(10, 40)).toBe("about a third")
    expect(metRange(22, 44)).toBe("about half")
    expect(metRange(28, 40)).toBe("most")
    expect(metRange(1800, 3000)).toBe("about half")
    expect(metRange(40, 40)).toBe("nearly all")
    for (let attendees = MIN_ATTENDEES; attendees <= 60; attendees++) {
      let last = -1
      for (let connected = 0; connected <= attendees; connected++) {
        const word = metRange(connected, attendees)
        expect(word).not.toMatch(/\d/)
        const rank = MET_RANGES.indexOf(word as (typeof MET_RANGES)[number])
        expect(rank).toBeGreaterThanOrEqual(last)
        last = rank
      }
    }
  })

  it("never says everyone: a full room and one with a few left out read the same", () => {
    expect(metRange(40, 40)).toBe(metRange(37, 40))
  })
})

describe("venueMood: the mood a venue is shown, through discloseGroup", () => {
  it("is a few under five, and the word reads only what is shown", () => {
    expect(venueMood({ positive: 12, neutral: 3, negative: 0 })).toEqual({ parts: [12, "few", 0], word: "mostly positive" })
    expect(venueMood({ positive: 5, neutral: 5, negative: 6 })).toEqual({ parts: [5, 5, 6], word: "mixed" })
    // A bare majority is not "mostly": 6 against 5.
    expect(venueMood({ positive: 6, neutral: 0, negative: 5 })?.word).toBe("mixed")
    expect(venueMood({ positive: 6, neutral: 0, negative: 0 })?.word).toBe("mostly positive")
    expect(venueMood({ positive: 0, neutral: 2, negative: 9 })).toEqual({ parts: [0, "few", 9], word: "mostly negative" })
    expect(venueMood({ positive: 1, neutral: 2, negative: 3 })).toEqual({ parts: ["few", "few", "few"], word: "a few messages" })
    // Nothing classified is no mood at all, not a neutral one.
    expect(venueMood({ positive: 0, neutral: 0, negative: 0 })).toBeNull()
  })

  it("gives nothing away a disclosed group does not (brute force over three moods, 0 to 12)", () => {
    // Two nights whose moods disclose the same must read the same: same bar, same word.
    const seen = new Map<string, string>()
    for (let p = 0; p <= 12; p++)
      for (let n = 0; n <= 12; n++)
        for (let g = 0; g <= 12; g++) {
          const key = JSON.stringify(discloseGroup([p, n, g]))
          const shown = JSON.stringify(venueMood({ positive: p, neutral: n, negative: g }))
          if (seen.has(key)) expect(shown).toBe(seen.get(key))
          else seen.set(key, shown)
          const mood = venueMood({ positive: p, neutral: n, negative: g })
          for (const part of mood?.parts ?? []) if (typeof part === "number") expect(part === 0 || part >= MIN_CELL).toBe(true)
        }
  })
})

describe("the other cells", () => {
  it("came is a band, as every venue surface", () => {
    expect([0, 4, 5, 9, 10, 19, 20, 3000].map(cameBand)).toEqual(["Under 5", "Under 5", "5–9", "5–9", "10–19", "10–19", "20+", "20+"])
  })

  it("offers redeemed are under 5 from one to four, and none at zero", () => {
    expect([0, 1, 4, 5, 9, 10, 25].map(offersBand)).toEqual(["none", "under 5", "under 5", "5–9", "5–9", "10–19", "20+"])
  })

  it("crews here are a few under five, whatever the people", () => {
    expect([0, 1, 3, 4, 5, 12].map((c) => crewsCell(c))).toEqual(["none", "a few", "a few", "a few", "5", "12"])
    // Already a few from discloseCrews (the people are a few): stays a few.
    expect(crewsCell("few")).toBe("a few")
  })

  it("a rating is held under five raters, and absent with none", () => {
    expect(ratingCell([0, 0, 0, 0, 0])).toBeNull()
    expect(ratingCell([0, 0, 0, 1, 3])).toBe("held")
    expect(ratingCell([0, 0, 1, 3, 4])).toBe("4.4")
  })
})
