/*
 * A board post that beats OpenAI's one-second bound is looked at again
 * (SCRUM-301 review).
 *
 * The room's timeout pass is provisional — it stores, then `moderateMessage`
 * asks again without the bound and hides the row if it must. The board's first
 * version let a timeout through for good. `checkBoardText` now says when its
 * pass was unchecked, and `hideBoardPostIfFlagged` is the second look.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockUpdate = jest.fn()
jest.mock("@/lib/db", () => ({ db: { board_posts: { updateMany: (...a: unknown[]) => mockUpdate(...a) } } }))
const mockCheck = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  checkTextContent: (...a: unknown[]) => mockCheck(...a),
  notChecked: (reason: string) => ({ checked: false, reason }),
}))

import { checkBoardText, hideBoardPostIfFlagged } from "@/lib/board-access"

const HIDE = { checked: true, result: { action: "hide", source: "openai_text", categories: {}, confidence: 0.99 } }

beforeEach(() => {
  mockUpdate.mockReset()
  mockCheck.mockReset()
})

describe("checkBoardText", () => {
  it("passes provisionally when OpenAI does not answer in time", async () => {
    jest.useFakeTimers()
    mockCheck.mockReturnValue(new Promise(() => {}))
    const verdict = checkBoardText("anyone going from Indiranagar?")
    await jest.advanceTimersByTimeAsync(1000)
    await expect(verdict).resolves.toEqual({ refusal: null, unchecked: true })
    jest.useRealTimers()
  })

  it("passes for good when there is no key — a second look would not have one either", async () => {
    mockCheck.mockResolvedValue({ checked: false, reason: "no_key" })
    await expect(checkBoardText("anyone going?")).resolves.toEqual({ refusal: null, unchecked: false })
  })

  it("refuses what OpenAI refuses inside the bound", async () => {
    mockCheck.mockResolvedValue(HIDE)
    await expect(checkBoardText("anyone going?")).resolves.toEqual({ refusal: "This can't go on the board.", unchecked: false })
  })
})

describe("hideBoardPostIfFlagged", () => {
  it("takes the post down, marked hidden, when the second look refuses it", async () => {
    mockCheck.mockResolvedValue(HIDE)
    await hideBoardPostIfFlagged("post-1", "something vile")
    expect(mockUpdate).toHaveBeenCalledWith({
      // `deleted_at: null` — a post its author withdrew meanwhile keeps its own record.
      where: { id: "post-1", deleted_at: null },
      data: expect.objectContaining({ moderation_status: "hidden", deleted_at: expect.any(Date) }),
    })
  })

  it("leaves a clean post, and one it still could not check, alone", async () => {
    mockCheck.mockResolvedValueOnce({ checked: true, result: null })
    await hideBoardPostIfFlagged("post-2", "anyone going?")
    mockCheck.mockResolvedValueOnce({ checked: false, reason: "error" })
    await hideBoardPostIfFlagged("post-3", "anyone going?")
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
