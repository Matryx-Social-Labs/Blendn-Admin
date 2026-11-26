/**
 * An image's `sexual/minors` score is its own bar (SCRUM-1163, launch gate 9).
 *
 * The score was folded into one max with the rest, so an image scoring 0.3 on
 * it was at most a "flag", and on profile and blur photos a flag is dropped.
 * For an image, a `sexual/minors` score at or over the child-safety bar is a
 * `hide` naming that category, whatever the other scores say. Text keeps its
 * thresholds: the same scores on a message are judged as before.
 */
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import { checkImageContent, checkTextContent } from "@/lib/moderation/openai-moderation"
import { CHILD_SAFETY_IMAGE_THRESHOLD } from "@/lib/moderation/config"

const SCORES = {
  hate: 0.1,
  "hate/threatening": 0.1,
  harassment: 0.1,
  "harassment/threatening": 0.1,
  "self-harm": 0.1,
  "self-harm/intent": 0.1,
  "self-harm/instructions": 0.1,
  sexual: 0.1,
  "sexual/minors": 0.1,
  violence: 0.1,
  "violence/graphic": 0.1,
}
const reply = (scores: Record<string, number>, flagged: boolean) =>
  ({ ok: true, status: 200, statusText: "OK", json: async () => ({ results: [{ flagged, category_scores: scores }] }) }) as Response

const fetchMock = jest.fn()
beforeEach(() => {
  jest.clearAllMocks()
  process.env.OPENAI_API_KEY = "sk-test"
  global.fetch = fetchMock as unknown as typeof fetch
})

const image = async (scores: Record<string, number>, flagged = false) => {
  fetchMock.mockResolvedValueOnce(reply(scores, flagged))
  return checkImageContent("https://example/img")
}
const text = async (scores: Record<string, number>, flagged = false) => {
  fetchMock.mockResolvedValueOnce(reply(scores, flagged))
  return checkTextContent("words")
}

describe("an image's sexual/minors score", () => {
  it("is 0.2", () => {
    expect(CHILD_SAFETY_IMAGE_THRESHOLD).toBe(0.2)
  })

  it("at 0.25 with everything else at 0.1 is a hide naming the category", async () => {
    const check = await image({ ...SCORES, "sexual/minors": 0.25 })
    expect(check).toEqual({
      checked: true,
      result: { action: "hide", source: "openai_image", categories: { "sexual/minors": 0.25 }, confidence: 0.25 },
    })
  })

  it("is a hide even when the vendor did not flag it and something else scores higher", async () => {
    const check = await image({ ...SCORES, violence: 0.6, "sexual/minors": 0.3 }, true)
    expect(check.checked && check.result?.action).toBe("hide")
    expect(check.checked && check.result?.categories).toEqual({ violence: 0.6, "sexual/minors": 0.3 })
  })

  it("is a hide exactly at the bar", async () => {
    const check = await image({ ...SCORES, "sexual/minors": CHILD_SAFETY_IMAGE_THRESHOLD })
    expect(check.checked && check.result?.action).toBe("hide")
  })

  it("just under the bar is judged as before: clean when nothing reaches the flag threshold", async () => {
    expect(await image({ ...SCORES, "sexual/minors": 0.19 })).toEqual({ checked: true, result: null })
  })

  it("at 0.1 is judged as before", async () => {
    expect(await image({ ...SCORES, "sexual/minors": 0.1 })).toEqual({ checked: true, result: null })
    // Flagged by the vendor with every score low: a flag, as today, not a hide.
    const flagged = await image({ ...SCORES, sexual: 0.15, "sexual/minors": 0.1 }, true)
    expect(flagged.checked && flagged.result?.action).toBe("flag")
  })
})

describe("text keeps its thresholds (negative control)", () => {
  it("the same 0.25 on a message is not a hide", async () => {
    expect(await text({ ...SCORES, "sexual/minors": 0.25 })).toEqual({ checked: true, result: null })
    const flagged = await text({ ...SCORES, "sexual/minors": 0.25 }, true)
    expect(flagged.checked && flagged.result?.action).toBe("flag")
  })
})
