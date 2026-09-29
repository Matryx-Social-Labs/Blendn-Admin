/*
 * A room message's media is screened whatever the message says it is (SCRUM-444).
 *
 * `moderateMessage` looked at the image only when `type` was "image" or "gif".
 * The type is the client's word: `{ type: "text", metadata: { mediaUrl } }`
 * stored an image nobody screened, and so did `type: "video"` over a JPEG, which
 * was then recorded clean. Now any media goes to the image check; one it can't
 * read (a clip) is recorded unchecked, which is the truth.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/db", () => ({ db: {} }))
process.env.TIGRIS_ENDPOINT = "https://fly.storage.tigris.dev"
process.env.TIGRIS_ACCESS_KEY = "test-access"
process.env.TIGRIS_SECRET_KEY = "test-secret"
process.env.TIGRIS_BUCKET = "blendn-media-test"

const USER = "cmuser0000000000000000001"
const media = `https://blendn-media-test-private.fly.storage.tigris.dev/chat/${USER}/1790000000000-abc123-sealed`

const checkImageContent = jest.fn()
const recordExamined = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  checkTextContent: jest.fn().mockResolvedValue({ checked: true, result: null }),
  checkImageContent: (...args: unknown[]) => checkImageContent(...args),
}))
jest.mock("@/lib/moderation/actions", () => ({
  hideMessage: jest.fn(),
  flagForReview: jest.fn(),
  checkAndAutoMute: jest.fn(),
  recordExamined: (...args: unknown[]) => recordExamined(...args),
}))

import { moderateMessage } from "@/lib/moderation"

beforeEach(() => jest.clearAllMocks())

describe("room media is screened whatever the message's type says", () => {
  it.each(["text", "video", "image"])("screens the image on a %s message", async (type) => {
    checkImageContent.mockResolvedValue({ checked: true, result: null })
    await moderateMessage("m1", "look", type, USER, "g1", media)
    expect(checkImageContent).toHaveBeenCalledTimes(1)
  })

  it("records media it could not read as unchecked, never clean", async () => {
    checkImageContent.mockResolvedValue({ checked: false })
    await moderateMessage("m1", "a clip", "video", USER, "g1", media)
    expect(recordExamined).toHaveBeenCalledWith("m1", false)
  })

  it("does not call the image check for a message with no media, null or left out", async () => {
    await moderateMessage("m1", "hello", "text", USER, "g1", null)
    await moderateMessage("m2", "hello", "text", USER, "g1")
    expect(checkImageContent).not.toHaveBeenCalled()
  })

  it("hands the check the media itself, signed", async () => {
    checkImageContent.mockResolvedValue({ checked: true, result: null })
    await moderateMessage("m1", "look", "text", USER, "g1", media)
    const url = new URL(checkImageContent.mock.calls[0][0])
    expect(url.pathname.endsWith(new URL(media).pathname)).toBe(true)
    expect(url.searchParams.has("X-Amz-Signature")).toBe(true)
  })
})
