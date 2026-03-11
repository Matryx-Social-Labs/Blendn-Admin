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
})
