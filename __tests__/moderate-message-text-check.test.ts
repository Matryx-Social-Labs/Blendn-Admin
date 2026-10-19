const mockCheck = jest.fn()
const mockHide = jest.fn()
const mockRecord = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  checkTextContent: (...a: unknown[]) => mockCheck(...a),
  checkImageContent: jest.fn(),
}))
jest.mock("@/lib/moderation/actions", () => ({
  hideMessage: (...a: unknown[]) => mockHide(...a),
  flagForReview: jest.fn(),
  checkAndAutoMute: jest.fn(),
  recordExamined: (...a: unknown[]) => mockRecord(...a),
}))
jest.mock("@/lib/tigris", () => ({ readableUrl: jest.fn() }))

import { moderateMessage } from "@/lib/moderation"
import type { ModerationCheck } from "@/lib/moderation/openai-moderation"

/**
 * The post-hoc pipeline reuses the send route's in-flight OpenAI check, so one
 * call serves a message (perf/chat-path). Reusing it must not lose the retry the
 * pipeline always had for a check that FAILED: an abusive line that went out
 * unchecked because the API answered 429 or 5xx is looked at again.
 */
const HIDE = { checked: true, result: { action: "hide", source: "openai_text", categories: { hate: 0.99 }, confidence: 0.99 } } as const
const CLEAN: ModerationCheck = { checked: true, result: null }
const run = (textCheck?: Promise<ModerationCheck>) => moderateMessage("m1", "see you at nine", "text", "u1", "g1", undefined, textCheck)

beforeEach(() => jest.resetAllMocks())

describe("moderateMessage with the send route's in-flight check", () => {
  it("asks again when the in-flight check failed outright, and hides on the second answer", async () => {
    mockCheck.mockResolvedValue(HIDE)
    await run(Promise.resolve({ checked: false, reason: "error" }))
    expect(mockCheck).toHaveBeenCalledTimes(1)
    expect(mockHide).toHaveBeenCalledTimes(1)
  })

  it("does not ask again when the in-flight check answered, however slowly", async () => {
    const slow = new Promise<ModerationCheck>((resolve) => setTimeout(() => resolve(CLEAN), 50))
    await run(slow)
    expect(mockCheck).not.toHaveBeenCalled()
    expect(mockRecord).toHaveBeenCalledWith("m1", true)
  })

  it("uses the in-flight verdict when it is a hide", async () => {
    await run(Promise.resolve(HIDE))
    expect(mockCheck).not.toHaveBeenCalled()
    expect(mockHide).toHaveBeenCalledTimes(1)
  })

  it("does not ask again with no key configured, nor for a check that timed out (a second 8 s wait)", async () => {
    await run(Promise.resolve({ checked: false, reason: "no_key" }))
    await run(Promise.resolve({ checked: false, reason: "timeout" }))
    expect(mockCheck).not.toHaveBeenCalled()
    expect(mockRecord).toHaveBeenCalledWith("m1", false)
  })

  it("asks once, as before, when handed no check", async () => {
    mockCheck.mockResolvedValue(CLEAN)
    await run()
    expect(mockCheck).toHaveBeenCalledTimes(1)
  })
})
