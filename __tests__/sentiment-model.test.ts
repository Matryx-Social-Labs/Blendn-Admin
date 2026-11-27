/**
 * SCRUM-1226: the mood classifier's model is a setting, its transient failures
 * get one retry, and a failure that stays reaches Sentry once.
 *
 * It was `const MODEL = "gpt-4o-mini"`, which OpenAI shuts down on 2027-01-14;
 * after that every tier-3 call fails, and each failed message is written for
 * good with the lexicon's guess (`source: "lexicon"`). A 429 or a 502 did the
 * same, with no second try.
 */
const captureException = jest.fn()
const captureMessage = jest.fn()
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

import { classifyMessages } from "@/lib/sentiment/classify"

const DEFAULT_MODEL_UNDER_TEST = "gpt-6-luna"

// "where is the bar" is a cue with no opinion: the lexicon declines it, so it goes to the model.
const ESCALATED = { id: "m1", text: "where is the bar" }

function modelReply(
  content: string | null = JSON.stringify({
    results: [{ id: ESCALATED.id, sentiment: "neutral", category: "other", topic: null, confidence: 0.9 }],
  })
): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

const TIMEOUT = () => new DOMException("The operation was aborted due to timeout", "TimeoutError")
const NETWORK = () => new TypeError("fetch failed")

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>()
const sentModel = (call = 0) => JSON.parse(String(fetchMock.mock.calls[call][1].body)).model

const saved = { key: process.env.OPENAI_API_KEY, model: process.env.SENTIMENT_MODEL }

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key"
  delete process.env.SENTIMENT_MODEL
  fetchMock.mockReset()
  captureException.mockReset()
  captureMessage.mockReset()
  jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch)
  jest.spyOn(console, "error").mockImplementation()
  jest.spyOn(console, "warn").mockImplementation()
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  for (const [name, value] of [["OPENAI_API_KEY", saved.key], ["SENTIMENT_MODEL", saved.model]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/** Runs the classifier, letting the retry's backoff pass. */
async function classify() {
  const pending = classifyMessages([ESCALATED])
  await jest.runAllTimersAsync()
  return pending
}

describe("the model is a setting", () => {
  it("sends SENTIMENT_MODEL when it is set", async () => {
    // Negative control: on the hard-coded constant this sent gpt-4o-mini.
    process.env.SENTIMENT_MODEL = "some-other-model"
    fetchMock.mockResolvedValueOnce(modelReply())

    await classify()

    expect(sentModel()).toBe("some-other-model")
  })

  it("sends the supported default when it is unset, never the retiring gpt-4o-mini", async () => {
    fetchMock.mockResolvedValueOnce(modelReply())

    await classify()

    expect(sentModel()).toBe(DEFAULT_MODEL_UNDER_TEST)
  })

  it("asks for no reasoning and sends no temperature, which gpt-6-luna refuses at 0", async () => {
    fetchMock.mockResolvedValueOnce(modelReply())

    await classify()

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body).not.toHaveProperty("temperature")
    expect(body.reasoning_effort).toBe("none")
    expect(body.response_format).toEqual({ type: "json_object" })
  })

  it.each([["blank", "  ", DEFAULT_MODEL_UNDER_TEST], ["empty", "", DEFAULT_MODEL_UNDER_TEST], ["padded", " m ", "m"]])(
    "reads a %s SENTIMENT_MODEL",
    async (_, value, expected) => {
      process.env.SENTIMENT_MODEL = value
      fetchMock.mockResolvedValueOnce(modelReply())

      await classify()

      expect(sentModel()).toBe(expected)
    }
  )
})

describe("a transient failure is retried once", () => {
  it.each([429, 500, 503])("retries a %i, then keeps the model's label", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("", { status })).mockResolvedValueOnce(modelReply())

    const [result] = await classify()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.source).toBe("llm")
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it.each([["a timeout", TIMEOUT], ["a dropped connection", NETWORK]])("retries %s", async (_, error) => {
    fetchMock.mockRejectedValueOnce(error()).mockResolvedValueOnce(modelReply())

    const [result] = await classify()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.source).toBe("llm")
  })

  it("waits the backoff before the retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(modelReply())

    const pending = classifyMessages([ESCALATED])
    await jest.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [result] = await pending
    expect(result.source).toBe("llm")
  })

  it("does not answer a 4xx with a retry: a bad request or a dead model will not get better", async () => {
    // Negative control for the retry: a retry-everything loop calls twice here.
    fetchMock.mockResolvedValue(new Response("", { status: 404 }))

    const [result] = await classify()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // No row: the next pass reads it again (SCRUM-1481).
    expect(result).toBeUndefined()
  })
})

describe("a failure that stays reaches Sentry once, through logger.error", () => {
  it("reports two 500s as one Sentry issue with the status and the model", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }))

    const [result] = await classify()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // No row: the next pass reads it again (SCRUM-1481).
    expect(result).toBeUndefined()
    expect(captureException).not.toHaveBeenCalled()
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage.mock.calls[0][1]).toMatchObject({
      level: "error",
      extra: { status: 500, model: DEFAULT_MODEL_UNDER_TEST },
    })
  })

  it("reports a dead model's 404 at once, naming the model", async () => {
    process.env.SENTIMENT_MODEL = "a-retired-model"
    fetchMock.mockResolvedValue(new Response("", { status: 404 }))

    await classify()

    expect(captureException).not.toHaveBeenCalled()
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage.mock.calls[0][1]).toMatchObject({ extra: { status: 404, model: "a-retired-model" } })
  })

  it("reports two timeouts once", async () => {
    fetchMock.mockRejectedValue(TIMEOUT())

    const [result] = await classify()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // No row: the next pass reads it again (SCRUM-1481).
    expect(result).toBeUndefined()
    expect(captureException).not.toHaveBeenCalled()
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage.mock.calls[0][0]).toBe("Sentiment classification threw")
  })

  it("reports a dropped connection then a 404 once, as the 404", async () => {
    fetchMock.mockRejectedValueOnce(NETWORK()).mockResolvedValueOnce(new Response("", { status: 404 }))

    const [result] = await classify()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // No row: the next pass reads it again (SCRUM-1481).
    expect(result).toBeUndefined()
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage.mock.calls[0][1]).toMatchObject({ extra: { status: 404 } })
  })

  it("reports a 200 the model left empty, and leaves the batch for the next pass", async () => {
    // Was silent: `if (!content) return out`, no log at any level.
    fetchMock.mockResolvedValueOnce(modelReply(null))

    const [result] = await classify()

    // No row: the next pass reads it again (SCRUM-1481).
    expect(result).toBeUndefined()
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage.mock.calls[0][1]).toMatchObject({ extra: { labelled: 0, sent: 1, model: DEFAULT_MODEL_UNDER_TEST } })
  })

  it("reports a batch the model labelled only in part", async () => {
    const second = { id: "m2", text: "the sound was not great" } // a negation: the lexicon declines it
    fetchMock.mockResolvedValueOnce(modelReply())

    const pending = classifyMessages([ESCALATED, second])
    await jest.runAllTimersAsync()
    const results = await pending

    expect(results.find((r) => r.id === second.id)?.source).toBe("lexicon")
    // The model read the batch: what it left out is its answer, not an outage, and is not deferred.
    expect(results.deferred).toBe(0)
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage.mock.calls[0][1]).toMatchObject({ extra: { labelled: 1, sent: 2 } })
  })

  it("reports unparseable model output without quoting it: the output can echo a guest's message", async () => {
    fetchMock.mockResolvedValueOnce(modelReply("following"))

    await classify()

    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(captureMessage.mock.calls[0])).not.toContain("following")
  })
})
