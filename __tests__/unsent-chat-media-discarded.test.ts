import { readFileSync } from "fs"
import { join } from "path"

/**
 * A sealed chat copy whose message was never written is removed (SCRUM-448).
 *
 * The copy is made before the row, and its key names nobody, so erasure (which
 * finds copies through the messages pointing at them) can never reach one the
 * send did not keep: a failed write, or a clientId retry that lost the race.
 */
const mockDeleteFile = jest.fn()
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  deleteFile: (...a: unknown[]) => mockDeleteFile(...a),
}))
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import { discardSealedChatMedia } from "@/lib/validations/chat"
import { logger } from "@/lib/logger"

const SEALED = "chat/sealed/0b8e2c1e-6a7f-4f2a-9a55-3c1d2e4f5a6b"
const HOST = `https://${process.env.TIGRIS_PRIVATE_BUCKET || `${process.env.TIGRIS_BUCKET || "blendn-media"}-private`}.fly.storage.tigris.dev`

beforeEach(() => jest.clearAllMocks())

describe("discardSealedChatMedia", () => {
  it("removes the sealed copy", async () => {
    mockDeleteFile.mockResolvedValue(undefined)
    await discardSealedChatMedia({ url: `${HOST}/${SEALED}` })
    expect(mockDeleteFile).toHaveBeenCalledWith(SEALED)
  })

  it("touches nothing that is not a sealed chat copy", async () => {
    await discardSealedChatMedia(null)
    await discardSealedChatMedia({ refusal: "That photo is empty. Try again." })
    await discardSealedChatMedia({ url: `${HOST}/chat/someone/1-a-sealed` })
    await discardSealedChatMedia({ url: "https://example.com/chat/sealed/0b8e2c1e-6a7f-4f2a-9a55-3c1d2e4f5a6b" })
    expect(mockDeleteFile).not.toHaveBeenCalled()
  })

  it("logs a storage failure rather than replacing the send's own error", async () => {
    mockDeleteFile.mockRejectedValue(new Error("slow down"))
    await expect(discardSealedChatMedia({ url: `${HOST}/${SEALED}` })).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ key: SEALED, error: "slow down" }))
  })
})

describe.each([
  "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
  "app/api/mobile/events/[eventId]/chat/route.ts",
  "app/api/mobile/conversations/[conversationId]/messages/route.ts",
])("%s", (file) => {
  it("discards the sealed copy in every write that can fail after sealing", () => {
    const src = readFileSync(join(__dirname, "..", file), "utf8")
    const races = src.match(/"P2002"/g)?.length ?? 0
    const discards = src.match(/await discardSealedChatMedia\(media\)/g)?.length ?? 0
    expect(src).toContain("sealChatMedia(")
    expect(races).toBeGreaterThan(0)
    expect(discards).toBe(races)
  })
})
