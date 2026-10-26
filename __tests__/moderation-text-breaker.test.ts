/**
 * When OpenAI is down, the text check stops asking (moderation-degraded policy).
 *
 * Five failures in a row open a 30 s breaker: every call in that window answers
 * "did not look" without touching the network, so a small room loses no time
 * and a big one can refuse at once. After the window the next call is the
 * probe. A missing key is configuration, not an outage, and never counts.
 */
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import {
  BREAKER_FAILURES_TO_OPEN,
  BREAKER_OPEN_MS,
  breakerIsOpen,
  recordTextSuccess,
} from "@/lib/moderation/text-breaker"
import { checkTextContent, checkTextContents } from "@/lib/moderation/openai-moderation"

const CLEAN = { results: [{ flagged: false, category_scores: { sexual: 0.01, violence: 0.01 } }] }
const HATE = { flagged: true, category_scores: { hate: 0.97, violence: 0.01 } }
const ok = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body }) as Response
const down = () => ({ ok: false, status: 503, statusText: "x", json: async () => ({}) }) as Response

const fetchMock = jest.fn()
beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-10-24T12:00:00Z") })
  jest.clearAllMocks()
  recordTextSuccess()
  process.env.OPENAI_API_KEY = "sk-test"
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => jest.useRealTimers())

async function failTimes(n: number) {
  fetchMock.mockResolvedValue(down())
  for (let i = 0; i < n; i++) await checkTextContent("hello")
}

describe("the text moderation breaker", () => {
  it("stays closed below the threshold", async () => {
    await failTimes(BREAKER_FAILURES_TO_OPEN - 1)
    expect(breakerIsOpen()).toBe(false)
  })

  it("opens after five consecutive failures and then skips the network", async () => {
    await failTimes(BREAKER_FAILURES_TO_OPEN)
    expect(breakerIsOpen()).toBe(true)
    fetchMock.mockClear()
    expect(await checkTextContent("hello")).toEqual({ checked: false, reason: "error" })
    expect(await checkTextContents(["a", "b"])).toEqual([
      { checked: false, reason: "error" },
      { checked: false, reason: "error" },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a success resets the count, so failures must be consecutive", async () => {
    await failTimes(BREAKER_FAILURES_TO_OPEN - 1)
    fetchMock.mockResolvedValue(ok(CLEAN))
    await checkTextContent("hello")
    await failTimes(BREAKER_FAILURES_TO_OPEN - 1)
    expect(breakerIsOpen()).toBe(false)
  })

  it("lets one probe through after 30 s: success closes it", async () => {
    await failTimes(BREAKER_FAILURES_TO_OPEN)
    jest.setSystemTime(Date.now() + BREAKER_OPEN_MS + 1)
    expect(breakerIsOpen()).toBe(false)
    fetchMock.mockResolvedValue(ok(CLEAN))
    expect(await checkTextContent("hello")).toEqual({ checked: true, result: null })
    // Still closed on the next failure: the count started over.
    fetchMock.mockResolvedValue(down())
    await checkTextContent("hello")
    expect(breakerIsOpen()).toBe(false)
  })

  it("a failed probe reopens it for another 30 s", async () => {
    await failTimes(BREAKER_FAILURES_TO_OPEN)
    jest.setSystemTime(Date.now() + BREAKER_OPEN_MS + 1)
    fetchMock.mockResolvedValue(down())
    await checkTextContent("hello")
    expect(breakerIsOpen()).toBe(true)
  })

  it("a timeout counts as a failure", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" })
    fetchMock.mockRejectedValue(timeout)
    for (let i = 0; i < BREAKER_FAILURES_TO_OPEN; i++) {
      expect(await checkTextContent("hello")).toEqual({ checked: false, reason: "timeout" })
    }
    expect(breakerIsOpen()).toBe(true)
  })

  it("a missing key is no_key and never counts", async () => {
    delete process.env.OPENAI_API_KEY
    for (let i = 0; i < BREAKER_FAILURES_TO_OPEN * 2; i++) {
      expect(await checkTextContent("hello")).toEqual({ checked: false, reason: "no_key" })
    }
    expect(breakerIsOpen()).toBe(false)
  })
})

describe("checkTextContents", () => {
  it("answers one check per input, in order, scored like the single call", async () => {
    fetchMock.mockResolvedValue(ok({ results: [CLEAN.results[0], HATE] }))
    const out = await checkTextContents(["fine", "awful"])
    expect(out[0]).toEqual({ checked: true, result: null })
    expect(out[1]).toMatchObject({ checked: true, result: { action: "hide", source: "openai_text" } })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.input).toEqual(["fine", "awful"])
  })

  it("splits into chunks and keeps the order", async () => {
    const inputs = Array.from({ length: 70 }, (_, i) => `m${i}`)
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) =>
      ok({ results: JSON.parse(init.body).input.map(() => CLEAN.results[0]) })
    )
    const out = await checkTextContents(inputs)
    expect(out).toHaveLength(70)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("marks a chunk it could not check as such and counts one failure", async () => {
    fetchMock.mockResolvedValue(down())
    expect(await checkTextContents(["a", "b"])).toEqual([
      { checked: false, reason: "error" },
      { checked: false, reason: "error" },
    ])
  })

  it("treats a short reply as a failure rather than guessing which input it was for", async () => {
    fetchMock.mockResolvedValue(ok({ results: [CLEAN.results[0]] }))
    expect(await checkTextContents(["a", "b"])).toEqual([
      { checked: false, reason: "error" },
      { checked: false, reason: "error" },
    ])
  })

  it("does nothing for an empty list", async () => {
    expect(await checkTextContents([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
