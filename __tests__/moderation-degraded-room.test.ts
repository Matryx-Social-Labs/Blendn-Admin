/** The big-room rule is for event rooms only; every other kind carries on as before (moderation-degraded policy). */
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock("@/lib/db", () => ({ db: { chat_messages: { delete: jest.fn() } } }))
const mockHere = jest.fn()
jest.mock("@/lib/attendee-counts", () => ({ hereCountFor: (...a: unknown[]) => mockHere(...a) }))

import { BIG_ROOM_HERE_COUNT, refuseBigRoomWhileDown, verdictForBigRoom } from "@/lib/moderation/degraded-room"
import { BREAKER_FAILURES_TO_OPEN, recordTextFailure, recordTextSuccess } from "@/lib/moderation/text-breaker"
import type { ModerationCheck } from "@/lib/moderation/openai-moderation"

const DOWN: ModerationCheck = { checked: false, reason: "error" }
const CLEAN: ModerationCheck = { checked: true, result: null }

beforeEach(() => {
  jest.clearAllMocks()
  recordTextSuccess()
})

describe("verdictForBigRoom", () => {
  it("passes a non-event room through without counting anyone", async () => {
    expect(await verdictForBigRoom(null, DOWN, Promise.resolve(DOWN))).toBe(DOWN)
    expect(mockHere).not.toHaveBeenCalled()
  })

  it("passes a room at the boundary through: the rule is strictly more than 200", async () => {
    mockHere.mockResolvedValue(BIG_ROOM_HERE_COUNT)
    expect(await verdictForBigRoom("e1", DOWN, Promise.resolve(DOWN))).toBe(DOWN)
  })

  it("refuses (null) a big room whose call in flight also has no verdict", async () => {
    mockHere.mockResolvedValue(BIG_ROOM_HERE_COUNT + 1)
    expect(await verdictForBigRoom("e1", DOWN, Promise.resolve(DOWN))).toBeNull()
  })

  it("takes the verdict a big room's call in flight comes back with", async () => {
    mockHere.mockResolvedValue(BIG_ROOM_HERE_COUNT + 1)
    expect(await verdictForBigRoom("e1", DOWN, Promise.resolve(CLEAN))).toBe(CLEAN)
  })
})

describe("refuseBigRoomWhileDown", () => {
  it("does not count anyone while the breaker is closed", async () => {
    expect(await refuseBigRoomWhileDown("e1")).toBeNull()
    expect(mockHere).not.toHaveBeenCalled()
  })

  it("does not refuse a non-event room even with the breaker open", async () => {
    for (let i = 0; i < BREAKER_FAILURES_TO_OPEN; i++) recordTextFailure()
    expect(await refuseBigRoomWhileDown(null)).toBeNull()
  })
})
