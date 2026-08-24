import { checkKeywords } from "@/lib/moderation/keyword-filter"

describe("checkKeywords", () => {
  it("returns null for clean text", () => {
    expect(checkKeywords("Hello, how are you today?")).toBeNull()
    expect(checkKeywords("Great event, loved the music!")).toBeNull()
    expect(checkKeywords("Can we meet at 5pm?")).toBeNull()
  })

  it("detects English profanity", () => {
    const result = checkKeywords("you are a retard")
    expect(result).not.toBeNull()
    expect(result!.source).toBe("keyword")
    expect(result!.confidence).toBeGreaterThanOrEqual(0.7)
  })

  it("detects Hindi transliterated profanity", () => {
    const result = checkKeywords("tu ek chutiya hai")
    expect(result).not.toBeNull()
    expect(result!.matched).toContain("chutiya")
  })

  it("detects Hindi Devanagari profanity", () => {
    const result = checkKeywords("तू एक चूतिया है")
    expect(result).not.toBeNull()
    expect(result!.matched).toContain("चूतिया")
  })

  it("detects Tamil profanity", () => {
    const result = checkKeywords("thevadiya")
    expect(result).not.toBeNull()
  })

  it("detects Telugu profanity", () => {
    const result = checkKeywords("dengu lanja")
    expect(result).not.toBeNull()
    expect(result!.matched!.length).toBeGreaterThanOrEqual(2)
  })

  it("detects abbreviation keywords", () => {
    const result = checkKeywords("bc tu pagal hai")
    expect(result).not.toBeNull()
  })

  it("handles leetspeak evasion", () => {
    const result = checkKeywords("r3t4rd")
    expect(result).not.toBeNull()
    expect(result!.matched).toContain("retard")
  })

  it("handles separator evasion", () => {
    const result = checkKeywords("r-e-t-a-r-d")
    expect(result).not.toBeNull()
  })

  it("returns hide action for high confidence", () => {
    const result = checkKeywords("nigger faggot retard")
    expect(result).not.toBeNull()
    expect(result!.action).toBe("hide")
    expect(result!.confidence).toBeGreaterThanOrEqual(0.85)
  })

  it("deduplicates matched keywords", () => {
    const result = checkKeywords("retard retard retard")
    expect(result).not.toBeNull()
    // matched array should deduplicate
    const uniqueMatched = new Set(result!.matched)
    expect(uniqueMatched.size).toBe(result!.matched!.length)
  })

  /*
   * The Scunthorpe problem, and why it was worse than a wrong verdict.
   *
   * `normalize` strips every separator, so "the flag" became "theflag", which
   * contains `fag`. That auto-hid at 0.85 confidence — and three auto-hides in
   * an hour is an auto-mute, so an ordinary sentence was a third of a silencing.
   * The docstring above the function claimed "exact-match on normalized tokens
   * — high precision, low false-positive rate"; it was `String.includes`.
   */
  it("does not auto-hide ordinary English that merely contains a slur", () => {
    for (const clean of ["the flag", "Scunthorpe", "an assassin", "Bangkok"]) {
      const result = checkKeywords(clean)
      if (result) {
        expect(result.action).toBe("flag")
        expect(result.confidence).toBeLessThan(0.7)
      }
    }
  })

  it("still hides the same word standing on its own", () => {
    const result = checkKeywords("you are a fag")
    expect(result).not.toBeNull()
    expect(result!.action).toBe("hide")
    expect(result!.matched).toContain("fag")
  })

  it("still catches separator evasion, at a lower confidence", () => {
    /*
     * Nothing stops being detected. What changes is the cost of being wrong: a
     * suspicion buys a human glance instead of an automatic hide.
     */
    const result = checkKeywords("f.a.g")
    expect(result).not.toBeNull()
    expect(result!.action).toBe("flag")
    expect(result!.confidence).toBe(0.5)
  })

  it("does not stack suspicions into certainty", () => {
    /*
     * One sentence can manufacture several separator matches at once, and
     * summing them would put an ordinary line back over the auto-hide line by
     * a different route.
     */
    const result = checkKeywords("the flag at Scunthorpe near Bangkok")
    if (result) expect(result.confidence).toBe(0.5)
  })

  it("keeps whole-word matching in scripts that are not Latin", () => {
    /*
     * Tokenising on `\s` would have been enough for English and wrong for most
     * of the wordlists this file carries. The split is on non-letters, so
     * Devanagari and the rest survive it.
     */
    const result = checkKeywords("तुम चूतिया हो")
    expect(result).not.toBeNull()
    expect(result!.action).toBe("hide")
    expect(result!.matched).toContain("चूतिया")
  })
})
