const mockCheck = jest.fn()
const mockHide = jest.fn()
const mockRecord = jest.fn()
const mockFlag = jest.fn()
const mockMute = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  checkTextContent: (...a: unknown[]) => mockCheck(...a),
  checkImageContent: jest.fn(),
}))
jest.mock("@/lib/moderation/actions", () => ({
  hideMessage: (...a: unknown[]) => mockHide(...a),
  flagForReview: (...a: unknown[]) => mockFlag(...a),
  checkAndAutoMute: (...a: unknown[]) => mockMute(...a),
  recordExamined: (...a: unknown[]) => mockRecord(...a),
}))
jest.mock("@/lib/tigris", () => ({ readableUrl: jest.fn() }))

import { inlineFlags, moderateMessage } from "@/lib/moderation"
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

describe("a keyword flag on the async path (SCRUM-1167)", () => {
  it("records an ordinary word on the review list for a human, does not hide it, and does not call it clean", async () => {
    await moderateMessage("m1", "chod yaar, let's go", "text", "u1", "g1", undefined, Promise.resolve(CLEAN))
    expect(mockHide).not.toHaveBeenCalled()
    expect(mockFlag).toHaveBeenCalledWith("m1", "g1", "u1", expect.objectContaining({ action: "flag", source: "keyword", matched: ["chod"] }))
    expect(mockRecord).not.toHaveBeenCalled()
  })
})

describe("a keyword hide on the async path (D-052a)", () => {
  const send = (content: string, textCheck?: Promise<ModerationCheck>) => moderateMessage("m1", content, "text", "u1", "g1", undefined, textCheck)

  it("hides a swear word and does not count it when the model finds the line clean", async () => {
    await send("tu chutiya hai", Promise.resolve(CLEAN))
    expect(mockHide).toHaveBeenCalledTimes(1)
    expect(mockFlag).toHaveBeenCalledTimes(1)
    expect(mockFlag).toHaveBeenCalledWith("m1", "g1", "u1", expect.objectContaining({ source: "keyword", categories: { profanity: expect.any(Number) } }))
    expect(mockMute).not.toHaveBeenCalled()
  })

  it("records the model's hide on a line that also carries a swear word, and counts it", async () => {
    await send("tu chutiya hai", Promise.resolve(HIDE))
    expect(mockHide).toHaveBeenCalledTimes(1)
    expect(mockFlag).toHaveBeenNthCalledWith(2, "m1", "g1", "u1", HIDE.result)
    expect(mockMute).toHaveBeenCalledWith("u1", "g1")
  })

  it("asks again when the call failed outright, as the rest of the pipeline does, and counts a hide", async () => {
    mockCheck.mockResolvedValue(HIDE)
    await send("tu chutiya hai", Promise.resolve({ checked: false, reason: "error" }))
    expect(mockCheck).toHaveBeenCalledTimes(1)
    expect(mockMute).toHaveBeenCalledWith("u1", "g1")
  })

  it("does not count the line when the model could not judge it", async () => {
    await send("tu chutiya hai", Promise.resolve({ checked: false, reason: "timeout" }))
    expect(mockFlag).toHaveBeenCalledTimes(1)
    expect(mockMute).not.toHaveBeenCalled()
  })

  it("counts a slur without asking the model", async () => {
    await send("you are a retard")
    expect(mockCheck).not.toHaveBeenCalled()
    expect(mockMute).toHaveBeenCalledWith("u1", "g1")
  })
})

it("inlineFlags keeps only the flags, in order, and drops a hide or nothing (SCRUM-1167)", () => {
  const flag = (source: "keyword" | "openai_text") => ({ action: "flag" as const, source, categories: {}, confidence: 0.5 })
  expect(inlineFlags(flag("openai_text"), flag("keyword"))).toEqual([flag("openai_text"), flag("keyword")])
  expect(inlineFlags({ ...flag("keyword"), action: "hide" }, null)).toEqual([])
})
