import { discloseTopics } from "@/lib/disclosure"
import { tallyFeedback, type TallyRow } from "@/lib/feedback-digest"
import { forVenue, type LiveSnapshot } from "@/lib/live-metrics"
import { classifyMessages } from "@/lib/sentiment/classify"
import { classifyWithLexicon, lexiconFallback } from "@/lib/sentiment/lexicon"
import { FEEDBACK_TOPICS } from "@/lib/sentiment/taxonomy"

/*
 * Positive topics (SCRUM-1101, owner approval 5): at most five labels, only on
 * positive messages, counted by distinct people and shown from five people up.
 */

const row = (userId: string | null, topic: TallyRow["topic"], sentiment: TallyRow["sentiment"] = "positive"): TallyRow => ({ userId, topic, sentiment, category: "other" })

describe("the label", () => {
  it("is at most five, whatever the event", () => expect(FEEDBACK_TOPICS).toHaveLength(5))

  it("is the one thing a plainly positive message names, and none when it names two or none", () => {
    expect(classifyWithLexicon("the DJ is incredible tonight")?.topic).toBe("music")
    expect(classifyWithLexicon("loved the talk on agents")?.topic).toBe("program")
    expect(classifyWithLexicon("such a lovely crowd")?.topic).toBe("people")
    expect(classifyWithLexicon("the coffee is excellent")?.topic).toBe("food_drink")
    expect(classifyWithLexicon("amazing rooftop")?.topic).toBe("place")
    expect(classifyWithLexicon("amazing band and great food")).toMatchObject({ sentiment: "positive", topic: null })
    expect(classifyWithLexicon("so good, amazing night")?.topic).toBeNull()
  })

  it("is never on a message that is not positive", () => {
    expect(classifyWithLexicon("the music was terrible")).toMatchObject({ sentiment: "negative", topic: null })
    expect(classifyWithLexicon("anyone getting there early?")?.topic).toBeNull()
    expect(lexiconFallback("the music").topic).toBeNull()
  })

  describe("from the model", () => {
    const realFetch = global.fetch
    const realKey = process.env.OPENAI_API_KEY
    afterEach(() => {
      global.fetch = realFetch
      if (realKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = realKey
    })
    const answer = async (results: unknown[]) => {
      process.env.OPENAI_API_KEY = "k"
      const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ results }) } }] }) }))
      global.fetch = fetchMock as never
      // Ambiguity markers send all of these to the model.
      const out = await classifyMessages(results.map((r) => ({ id: (r as { id: string }).id, text: "great lol" })))
      return { out: new Map(out.map((c) => [c.id, c])), fetchMock }
    }

    it("keeps a listed topic on a positive message, and drops it, never the message, otherwise", async () => {
      const base = { category: "other", confidence: 0.9 }
      const { out, fetchMock } = await answer([
        { id: "a", sentiment: "positive", topic: "music", ...base },
        { id: "b", sentiment: "negative", topic: "music", ...base },
        { id: "c", sentiment: "positive", topic: "the lead singer, Asha", ...base },
        { id: "d", sentiment: "positive", ...base },
        { id: "e", sentiment: "positive", topic: ["music"], ...base },
      ])
      expect([...out.values()].map((c) => [c.id, c.sentiment, c.topic, c.source])).toEqual([
        ["a", "positive", "music", "llm"],
        ["b", "negative", null, "llm"],
        ["c", "positive", null, "llm"],
        ["d", "positive", null, "llm"],
        ["e", "positive", null, "llm"],
      ])
      const prompt = JSON.stringify(fetchMock.mock.calls)
      for (const topic of FEEDBACK_TOPICS) expect(prompt).toContain(topic)
    })
  })
})

describe("the count", () => {
  it("is distinct people over positive messages: one person is one, a corrected or purged message is nobody", () => {
    const { topics } = tallyFeedback([
      row("a", "music"), row("a", "music"), row("b", "music"),
      row("c", "music", "negative"), row("d", "music", "neutral"),
      row(null, "music"), row("e", null), row("f", "place"),
    ])
    expect(Object.fromEntries(topics)).toEqual({ music: 2, place: 1 })
  })
})

describe("what a host is shown", () => {
  it("is the topics five or more people named, most first; the rest are left out, not listed as a few", () => {
    const people = new Map([["place", 5], ["music", 18], ["program", 4], ["food_drink", 1], ["people", 9]])
    expect(discloseTopics(people, 60)).toEqual([
      { topic: "music", people: 18 },
      { topic: "people", people: 9 },
      { topic: "place", people: 5 },
    ])
  })

  it("holds a topic the whole room, or all but one, named", () => {
    expect(discloseTopics(new Map([["music", 8]]), 8)).toEqual([])
    expect(discloseTopics(new Map([["music", 8]]), 9)).toEqual([])
    expect(discloseTopics(new Map([["music", 8]]), 10)).toEqual([{ topic: "music", people: 8 }])
  })

  it("never reaches a venue's copy of the live view", () => {
    const s = {
      sentiment: { positive: 9, neutral: 0, negative: 0 }, categories: [], alerts: [], topics: [{ topic: "music", people: 9 }],
    } as unknown as LiveSnapshot
    expect(JSON.stringify(forVenue(s))).not.toContain("music")
  })
})
