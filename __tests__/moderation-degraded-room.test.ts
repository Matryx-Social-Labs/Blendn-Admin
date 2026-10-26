/** The big-room rule is for event rooms only; every other kind carries on as before (moderation-degraded policy). */
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
const mockUpdateMany = jest.fn()
jest.mock("@/lib/db", () => ({ db: { chat_messages: { delete: jest.fn(), updateMany: (...a: unknown[]) => mockUpdateMany(...a) } } }))
const mockHere = jest.fn()
jest.mock("@/lib/attendee-counts", () => ({ hereCountFor: (...a: unknown[]) => mockHere(...a) }))

import { BIG_ROOM_HERE_COUNT, refuseBigRoomWhileDown, verdictForBigRoom } from "@/lib/moderation/degraded-room"
import { BREAKER_FAILURES_TO_OPEN, recordTextFailure, recordTextSuccess } from "@/lib/moderation/text-breaker"
import type { ModerationCheck } from "@/lib/moderation/openai-moderation"

const DOWN: ModerationCheck = { checked: false, reason: "error" }
const CLEAN: ModerationCheck = { checked: true, result: null }
const HIDE: ModerationCheck = { checked: true, result: { action: "hide", source: "openai_text", categories: {}, confidence: 1 } }
const BIG = BIG_ROOM_HERE_COUNT + 1

beforeEach(() => {
  jest.clearAllMocks()
  mockUpdateMany.mockResolvedValue({ count: 1 })
  recordTextSuccess()
})

describe("verdictForBigRoom", () => {
  it("passes a non-event room through without counting anyone", async () => {
    expect(await verdictForBigRoom(null, "m1", DOWN, Promise.resolve(DOWN))).toEqual({ kind: "proceed", check: DOWN })
    expect(mockHere).not.toHaveBeenCalled()
  })

  it("passes a room at the boundary through: the rule is strictly more than 200", async () => {
    mockHere.mockResolvedValue(BIG_ROOM_HERE_COUNT)
    expect(await verdictForBigRoom("e1", "m1", DOWN, Promise.resolve(DOWN))).toEqual({ kind: "proceed", check: DOWN })
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it("refuses a big room whose call in flight also has no verdict", async () => {
    mockHere.mockResolvedValue(BIG)
    expect(await verdictForBigRoom("e1", "m1", DOWN, Promise.resolve(DOWN))).toEqual({ kind: "refuse" })
  })

  it("holds the row, takes the verdict, and releases only its own hold", async () => {
    mockHere.mockResolvedValue(BIG)
    expect(await verdictForBigRoom("e1", "m1", DOWN, Promise.resolve(CLEAN))).toEqual({ kind: "proceed", check: CLEAN })
    const [hold, release] = mockUpdateMany.mock.calls.map(([a]) => a)
    expect(hold.where).toEqual({ id: "m1", deleted_at: null })
    expect(release.where.deleted_at).toBe(hold.data.deleted_at)
    expect(release.data).toEqual({ deleted_at: null })
  })

  it("says removed when somebody else deleted the row during the wait", async () => {
    mockHere.mockResolvedValue(BIG)
    mockUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    expect(await verdictForBigRoom("e1", "m1", DOWN, Promise.resolve(CLEAN))).toEqual({ kind: "removed" })
  })

  it("says removed when the row was already gone before the hold", async () => {
    mockHere.mockResolvedValue(BIG)
    mockUpdateMany.mockResolvedValueOnce({ count: 0 })
    expect(await verdictForBigRoom("e1", "m1", DOWN, Promise.resolve(CLEAN))).toEqual({ kind: "removed" })
  })

  it("leaves the row held on a hide verdict: hideMessage follows", async () => {
    mockHere.mockResolvedValue(BIG)
    expect(await verdictForBigRoom("e1", "m1", DOWN, Promise.resolve(HIDE))).toEqual({ kind: "proceed", check: HIDE })
    expect(mockUpdateMany).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["the count fails", () => mockHere.mockRejectedValue(new Error("db"))],
    ["the hold fails", () => { mockHere.mockResolvedValue(BIG); mockUpdateMany.mockRejectedValue(new Error("db")) }],
    ["the release fails", () => { mockHere.mockResolvedValue(BIG); mockUpdateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("db")) }],
  ])("refuses, never delivers unchecked, when %s", async (_n, arrange) => {
    arrange()
    expect(await verdictForBigRoom("e1", "m1", DOWN, Promise.resolve(CLEAN))).toEqual({ kind: "refuse" })
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
