/**
 * OpenAI downloads the image itself, and sometimes cannot (SCRUM-732).
 *
 * A freshly written object on staging answered the vendor's fetch with
 * `400 "Failed to download image."` in 2 of 12 immediate calls (the same
 * bytes, the same URL, 200 a moment later). The check treated that as a
 * verdict-less failure and the photo stayed public and unchecked for ever.
 * A download failure is transient, so the photo path retries it; anything
 * that is not transient (a different 400, a clean verdict) is not retried.
 */
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import { logger } from "@/lib/logger"
import { checkImageContent } from "@/lib/moderation/openai-moderation"

const CLEAN = { results: [{ flagged: false, category_scores: { sexual: 0.01, violence: 0.01 } }] }
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, statusText: "x", json: async () => body, text: async () => JSON.stringify(body) }) as Response
const DOWNLOAD_FAILED = { error: { message: "Failed to download image.", type: "invalid_request_error" } }

const fetchMock = jest.fn()
beforeEach(() => {
  jest.clearAllMocks()
  process.env.OPENAI_API_KEY = "sk-test"
  global.fetch = fetchMock as unknown as typeof fetch
})

describe("checkImageContent", () => {
  it("retries a vendor download failure and returns the verdict of the retry", async () => {
    fetchMock.mockResolvedValueOnce(json(400, DOWNLOAD_FAILED)).mockResolvedValueOnce(json(200, CLEAN))
    const check = await checkImageContent("https://example/img", { retries: 2, retryDelayMs: 0 })
    expect(check).toEqual({ checked: true, result: null })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("gives up after the retries and says it did not look", async () => {
    fetchMock.mockResolvedValue(json(400, DOWNLOAD_FAILED))
    const check = await checkImageContent("https://example/img", { retries: 2, retryDelayMs: 0 })
    expect(check).toEqual({ checked: false, reason: "error" })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("does not retry unless asked: the chat path keeps its single attempt", async () => {
    fetchMock.mockResolvedValue(json(400, DOWNLOAD_FAILED))
    await checkImageContent("https://example/img")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not retry a 400 that is not a download failure", async () => {
    fetchMock.mockResolvedValue(json(400, { error: { message: "Invalid image format." } }))
    const check = await checkImageContent("https://example/img", { retries: 2, retryDelayMs: 0 })
    expect(check).toEqual({ checked: false, reason: "error" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries a 5xx and a 429", async () => {
    fetchMock.mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(429, {})).mockResolvedValueOnce(json(200, CLEAN))
    const check = await checkImageContent("https://example/img", { retries: 2, retryDelayMs: 0 })
    expect(check.checked).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("logs why the vendor refused, not only that it did", async () => {
    fetchMock.mockResolvedValue(json(400, DOWNLOAD_FAILED))
    await checkImageContent("https://example/img")
    expect(logger.warn).toHaveBeenCalledWith(
      "OpenAI Image Moderation API returned non-OK status",
      expect.objectContaining({ status: 400, body: expect.stringContaining("Failed to download image") })
    )
  })

  it("does not log a URL from the vendor's error: a private image's is a signed bearer link", async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: { message: "Failed to download image from https://bucket.example/chat/u/f?X-Amz-Credential=AKIA123&X-Amz-Signature=abc" } })
    )
    await checkImageContent("https://example/img")
    const logged = JSON.stringify((logger.warn as jest.Mock).mock.calls)
    expect(logged).toContain("Failed to download image")
    expect(logged).not.toMatch(/X-Amz|AKIA123|bucket\.example/)
  })
})
