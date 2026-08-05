import { classifyWithLexicon } from "@/lib/sentiment/lexicon"
import { classifyMessages } from "@/lib/sentiment/classify"
import { escalates, ISSUE_CATEGORIES, isIssueCategory } from "@/lib/sentiment/taxonomy"

/**
 * The lexicon tier's contract is narrow and worth pinning precisely: be sure,
 * or say you are not. It is measurably worse than a model at reading social
 * text, so every message it labels wrongly is a lie in the organiser's digest,
 * while every message it declines costs one slot in a batched API call.
 *
 * These assert it declines the cases it cannot see, and that the pipeline
 * degrades visibly rather than silently when the LLM tier is unavailable.
 */

describe("lexicon tier — labels only what is unambiguous", () => {
  it("confidently neutralises plain logistics chatter", () => {
    // The case this tier exists for: no opinion, no category, no LLM needed.
    const result = classifyWithLexicon("anyone getting there early? thinking 6:30")
    expect(result).not.toBeNull()
    expect(result!.sentiment).toBe("neutral")
    expect(result!.source).toBe("lexicon")
  })

  it("labels an unambiguous complaint with its category", () => {
    const result = classifyWithLexicon("the queue at the door was terrible")
    expect(result).not.toBeNull()
    expect(result!.sentiment).toBe("negative")
    expect(result!.category).toBe("entry_queue")
  })

  it("never claims more confidence than the model tier can", () => {
    const result = classifyWithLexicon("the sound was incredible")
    expect(result!.confidence).toBeLessThanOrEqual(0.8)
  })
})

describe("lexicon tier — escalates what it cannot see", () => {
  it("declines sarcasm rather than reading it literally", () => {
    // Scores positive on the word and negative in reality. The single most
    // important thing for a lexicon NOT to answer.
    expect(classifyWithLexicon("great, only queued 40 minutes for one bar 👍")).toBeNull()
  })

  it("declines when a negation could invert the polarity", () => {
    expect(classifyWithLexicon("the sound was not great")).toBeNull()
  })

  it("declines when both polarities appear", () => {
    expect(classifyWithLexicon("music was amazing but the bar was awful")).toBeNull()
  })

  it("declines a category cue with no clear opinion", () => {
    // "the bar" is not a complaint on its own.
    expect(classifyWithLexicon("where is the bar")).toBeNull()
  })

  it("always escalates anything that looks like a safety report", () => {
    // The one category where a false negative is unacceptable. A cue match is
    // not enough to clear it — it goes to a tier that actually reads the
    // sentence, even though that costs a call.
    for (const text of [
      "some guy near the bar keeps grabbing people",
      "my friend passed out, we need help",
      "a man has been following us around all night",
    ]) {
      expect(classifyWithLexicon(text)).toBeNull()
    }
  })

  it("declines empty or whitespace-only input", () => {
    expect(classifyWithLexicon("")).toBeNull()
    expect(classifyWithLexicon("   ")).toBeNull()
  })
})

describe("pipeline — degrades visibly, never silently", () => {
  const originalKey = process.env.OPENAI_API_KEY

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  })

  it("labels everything even with no API key, and marks the guesses low-confidence", async () => {
    delete process.env.OPENAI_API_KEY

    const results = await classifyMessages([
      { id: "a", text: "anyone getting there early?" },
      { id: "b", text: "great, only queued 40 minutes 👍" },
    ])

    // Nothing is dropped: an unlabelled message disappears from the digest
    // entirely, which is worse than an uncertain one.
    expect(results).toHaveLength(2)

    const escalated = results.find((r) => r.id === "b")!
    // The lexicon declined it and there was no tier 3, so it must present as a
    // guess rather than as a confident neutral.
    expect(escalated.confidence).toBeLessThan(0.5)
    expect(escalated.source).toBe("lexicon")

    const confident = results.find((r) => r.id === "a")!
    expect(confident.confidence).toBeGreaterThan(escalated.confidence)
  })

  it("returns a valid taxonomy label for every message, whatever the tier", async () => {
    delete process.env.OPENAI_API_KEY
    const results = await classifyMessages([
      { id: "a", text: "toilets were disgusting" },
      { id: "b", text: "not sure how I feel about it honestly" },
      { id: "c", text: "" },
    ])
    for (const r of results) {
      // Guards the group-bys that read this straight from the database.
      expect(isIssueCategory(r.category)).toBe(true)
      expect(["positive", "neutral", "negative"]).toContain(r.sentiment)
      expect(r.confidence).toBeGreaterThanOrEqual(0)
      expect(r.confidence).toBeLessThanOrEqual(1)
    }
  })
})

describe("taxonomy", () => {
  it("escalates safety_conduct and nothing else", () => {
    // Routing on category rather than tone means a calmly-worded report is not
    // deprioritised for being calm.
    expect(escalates("safety_conduct")).toBe(true)
    for (const c of ISSUE_CATEGORIES) {
      if (c !== "safety_conduct") expect(escalates(c)).toBe(false)
    }
  })

  it("keeps the set small enough to be used consistently", () => {
    // A thirty-label taxonomy gets applied inconsistently by both the
    // classifier and the humans correcting it.
    expect(ISSUE_CATEGORIES.length).toBeLessThanOrEqual(12)
  })
})
